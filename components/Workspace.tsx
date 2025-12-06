import React, { useState, useEffect, useRef, useMemo } from 'react';
import { PageStatus, DLM, DocumentBlock, SUPPORTED_LANGUAGES, BlockType, DocumentPage, TableMetadata } from '../types';
import { translateSegments } from '../services/geminiService';
import { ArrowRight, Download, RefreshCw, Loader2, Copy, Check, ChevronLeft, ChevronRight, ArrowLeft, AlertCircle } from './ui/Icons';

interface WorkspaceProps {
  dlm: DLM;
  activePageIndex: number;
  onPageChange: (index: number) => void;
  onUpdateDLM: (newDlm: DLM) => void;
  onBack: () => void;
  onRetryAnalysis: () => void;
}

// Helper to download files
const downloadFile = (content: string, filename: string, mimeType: string) => {
  const blob = new Blob([content], { type: mimeType });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
};

// --- LAYOUT ENGINE HELPERS ---

// 1. Font Size Estimator
// Estimates pixel font size based on bounding box height (normalized 0-1000)
// Assuming standard page height roughly 1100px-1400px, 1 unit ~ 1.2px
const getEstimatedFontSize = (bbox: number[]): string => {
  const height = bbox[2] - bbox[0]; // ymax - ymin
  // Tuned multiplier for visual balance on screen
  const size = Math.round(height * 0.14); 
  // Clamp values to readable ranges
  return `${Math.max(10, Math.min(size, 32))}px`;
};

// 2. Alignment Detector
// Infers text alignment based on X position
const getTextAlignment = (bbox: number[]): 'left' | 'center' | 'right' => {
  const xmin = bbox[1];
  const xmax = bbox[3];
  const width = xmax - xmin;
  const pageCenter = 500;
  
  // If block crosses the center significantly, likely centered
  if (Math.abs((xmin + width / 2) - pageCenter) < 50) return 'center';
  
  // If strictly on the right side
  if (xmin > 600) return 'right';
  
  return 'left';
};

// 3. Render Node Definition
type RenderNode = 
  | { type: 'row_group'; id: string; items: DocumentBlock[] } // New: For headers/forms
  | { type: 'table'; id: string; cells: DocumentBlock[]; colWidths: number[] } // New: colWidths
  | { type: 'list'; id: string; items: DocumentBlock[] }
  | { type: 'block'; data: DocumentBlock }; // Fallback

const groupBlocksForRendering = (blocks: DocumentBlock[]): RenderNode[] => {
    const nodes: RenderNode[] = [];
    let i = 0;

    while (i < blocks.length) {
        const block = blocks[i];
        
        // --- A. TABLE HANDLING ---
        if (block.type === BlockType.TABLE_CELL && block.table_metadata) {
            const tableId = block.table_metadata.table_id;
            const cells: DocumentBlock[] = [];
            
            while (i < blocks.length && blocks[i].type === BlockType.TABLE_CELL && blocks[i].table_metadata?.table_id === tableId) {
                cells.push(blocks[i]);
                i++;
            }

            // Calculate Column Widths for "table-layout: fixed"
            const colMaxX: Record<number, number> = {}; // Max X per column
            const colMinX: Record<number, number> = {}; // Min X per column
            
            cells.forEach(c => {
                const col = c.table_metadata?.col || 0;
                // Initialize if empty
                if (colMinX[col] === undefined) colMinX[col] = c.box_2d[1];
                if (colMaxX[col] === undefined) colMaxX[col] = c.box_2d[3];
                
                // Expand boundaries to find max width of column
                colMinX[col] = Math.min(colMinX[col], c.box_2d[1]);
                colMaxX[col] = Math.max(colMaxX[col], c.box_2d[3]);
            });

            const colWidths: number[] = [];
            const maxCols = Math.max(...Object.keys(colMaxX).map(Number)) + 1;
            
            // Calculate relative percentages based on 0-1000 scale
            // Note: This is an approximation. Total width might not be 1000 if table is narrow.
            // We use the table's total bounding box width as the denominator.
            
            // Find table boundaries
            const tableMinX = Math.min(...Object.values(colMinX));
            const tableMaxX = Math.max(...Object.values(colMaxX));
            const tableTotalWidth = tableMaxX - tableMinX || 1000;

            for (let c = 0; c < maxCols; c++) {
                 const w = (colMaxX[c] - colMinX[c]) || 0;
                 colWidths.push((w / tableTotalWidth) * 100);
            }

            nodes.push({ type: 'table', id: tableId, cells, colWidths });
            continue;
        }

        // --- B. LIST HANDLING ---
        if (block.type === BlockType.LIST_ITEM) {
             const items: DocumentBlock[] = [];
             while (i < blocks.length && blocks[i].type === BlockType.LIST_ITEM) {
                 items.push(blocks[i]);
                 i++;
             }
             nodes.push({ type: 'list', id: block.id, items });
             continue;
        }

        // --- C. ROW GROUPING (Heuristic for Headers/Forms) ---
        // If the current block is NOT a paragraph (e.g. heading, caption) 
        // AND the next block shares roughly the same Y position, group them.
        // Threshold: 20 units (~2% of page height)
        if (block.type !== BlockType.PARAGRAPH && i + 1 < blocks.length) {
             const nextBlock = blocks[i+1];
             const yDiff = Math.abs(block.box_2d[0] - nextBlock.box_2d[0]); // abs(ymin1 - ymin2)
             
             // Check if they are compatible types for a row (e.g. Header + Header, or Text + Text)
             // Avoid grouping big paragraphs with headers
             if (yDiff < 20 && nextBlock.type !== BlockType.TABLE_CELL) {
                 const rowItems = [block];
                 i++; // Consumed current
                 
                 // Consume subsequent blocks in same row
                 while (i < blocks.length) {
                     const curr = blocks[i];
                     const diff = Math.abs(block.box_2d[0] - curr.box_2d[0]);
                     if (diff < 20 && curr.type !== BlockType.TABLE_CELL) {
                         rowItems.push(curr);
                         i++;
                     } else {
                         break;
                     }
                 }
                 
                 // Sort items by X position (Left to Right)
                 rowItems.sort((a,b) => a.box_2d[1] - b.box_2d[1]);
                 nodes.push({ type: 'row_group', id: block.id, items: rowItems });
                 continue;
             }
        }
        
        // --- D. DEFAULT BLOCK ---
        nodes.push({ type: 'block', data: block });
        i++;
    }
    return nodes;
};

// Helper to generate HTML content from pages (Updated for Export)
const generateDocumentContent = (pages: DocumentPage[], title: string) => {
  let html = `
    <!DOCTYPE html>
    <html xmlns:o='urn:schemas-microsoft-com:office:office' xmlns:w='urn:schemas-microsoft-com:office:word' xmlns='http://www.w3.org/TR/REC-html40'>
    <head>
      <meta charset="UTF-8">
      <title>${title}</title>
      <style>
        body { font-family: 'Times New Roman', serif; line-height: 1.2; color: #000; font-size: 12pt; }
        .page-break { page-break-before: always; }
        
        /* Table Styles */
        table { border-collapse: collapse; width: 100%; margin-bottom: 1em; table-layout: fixed; }
        td, th { border: 1px solid #000; padding: 4px; vertical-align: top; word-wrap: break-word; }
        
        /* List Styles */
        ul { margin-top: 0; margin-bottom: 10px; padding-left: 20px; }
        
        /* Headings */
        h1, h2, h3, h4, h5, h6 { margin-top: 10px; margin-bottom: 5px; }
      </style>
    </head>
    <body>
  `;

  pages.forEach((page, index) => {
      if (page.blocks.length === 0) return;
      if (index > 0) html += `<div class="page-break"></div>`;
      
      const nodes = groupBlocksForRendering(page.blocks);
      
      nodes.forEach(node => {
          if (node.type === 'row_group') {
              // Word doesn't handle flexbox well. Use a table without borders for alignment.
              html += `<table style="border: none; width: 100%; margin-bottom: 10px;"><tr>`;
              node.items.forEach(item => {
                  const text = (item.translated_text || item.source_text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
                  const align = getTextAlignment(item.box_2d);
                  const fontWeight = item.type === BlockType.HEADING ? 'bold' : 'normal';
                  const style = `border: none; padding: 0 10px 0 0; text-align: ${align}; vertical-align: top;`;
                  
                  html += `<td style="${style}"><p style="margin:0; font-weight: ${fontWeight}">${text}</p></td>`;
              });
              html += `</tr></table>`;
          }
          else if (node.type === 'table') {
              html += `<table>`;
              // Colgroup for fixed widths
              html += `<colgroup>`;
              node.colWidths.forEach(w => {
                  html += `<col style="width: ${w}%">`;
              });
              html += `</colgroup>`;
              
              const rows: Record<number, DocumentBlock[]> = {};
              node.cells.forEach(cell => {
                  const r = cell.table_metadata?.row || 0;
                  if (!rows[r]) rows[r] = [];
                  rows[r].push(cell);
              });
              
              Object.keys(rows).sort((a,b) => Number(a)-Number(b)).forEach(rowIndex => {
                  html += `<tr>`;
                  const rowCells = rows[Number(rowIndex)].sort((a,b) => (a.table_metadata?.col || 0) - (b.table_metadata?.col || 0));
                  
                  rowCells.forEach(cell => {
                      const text = (cell.translated_text || cell.source_text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
                      const colspan = cell.table_metadata?.col_span || 1;
                      const rowspan = cell.table_metadata?.row_span || 1;
                      
                      html += `<td colspan="${colspan}" rowspan="${rowspan}">`;
                      // Handle Math fallback
                      if (cell.type === BlockType.MATH_FORMULA && cell.math_metadata?.latex) {
                           html += cell.source_text; 
                      } else {
                           html += text;
                      }
                      html += `</td>`;
                  });
                  html += `</tr>`;
              });
              html += `</table>`;
          }
          else if (node.type === 'list') {
              html += `<ul>`;
              node.items.forEach(item => {
                   const text = (item.translated_text || item.source_text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
                   html += `<li>${text}</li>`;
              });
              html += `</ul>`;
          }
          else if (node.type === 'block') {
              const block = node.data;
              const text = (block.translated_text || block.source_text || "").replace(/&/g, "&amp;").replace(/</g, "&lt;");
              const align = getTextAlignment(block.box_2d);
              
              if (block.type === BlockType.HEADING) {
                  html += `<h3 style="text-align: ${align}">${text}</h3>`;
              } else if (block.type === BlockType.MATH_FORMULA) {
                  html += `<p style="text-align: center; font-style: italic;">${text}</p>`;
              } else if (block.type === BlockType.IMAGE) {
                   html += `<p style="text-align: center; color: #666;">[Image]</p>`;
              } else {
                  html += `<p style="text-align: ${align}">${text}</p>`;
              }
          }
      });
  });

  html += `</body></html>`;
  return html;
};

const SkeletonLoader = () => (
  <div className="w-full h-full py-2 space-y-8 animate-pulse select-none">
    <div className="flex justify-between">
       <div className="h-4 bg-gray-100 rounded w-1/3"></div>
       <div className="h-4 bg-gray-100 rounded w-1/4"></div>
    </div>
    <div className="h-8 bg-gray-100 rounded-md w-1/2 mx-auto mb-8"></div>
    
    <div className="h-64 bg-gray-50 rounded border border-gray-100"></div>

    <div className="space-y-3">
        <div className="h-4 bg-gray-100 rounded w-full"></div>
        <div className="h-4 bg-gray-100 rounded w-5/6"></div>
    </div>
    
    <div className="flex items-center justify-center pt-10">
       <p className="text-sm text-gray-400 font-medium animate-pulse flex items-center gap-2">
         <Loader2 className="w-4 h-4 animate-spin" />
         AI is reconstructing layout...
       </p>
    </div>
  </div>
);

const Workspace: React.FC<WorkspaceProps> = ({ dlm, activePageIndex, onPageChange, onUpdateDLM, onBack, onRetryAnalysis }) => {
  const [targetLang, setTargetLang] = useState('vi');
  const [hoveredBlockId, setHoveredBlockId] = useState<string | null>(null);
  const [isSticky, setIsSticky] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  
  const exportMenuRef = useRef<HTMLDivElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const currentPage = dlm.pages[activePageIndex];
  const status = currentPage.status;

  const renderNodes = useMemo(() => {
     if (!currentPage) return [];
     return groupBlocksForRendering(currentPage.blocks);
  }, [currentPage]);

  useEffect(() => {
    const handleScroll = () => {
      setIsSticky(window.scrollY > 80);
    };
    
    const handleClickOutside = (event: MouseEvent) => {
      if (exportMenuRef.current && !exportMenuRef.current.contains(event.target as Node)) {
        setShowExportMenu(false);
      }
    };

    window.addEventListener('scroll', handleScroll);
    document.addEventListener('mousedown', handleClickOutside);
    
    return () => {
      window.removeEventListener('scroll', handleScroll);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  const handleTranslatePage = async () => {
    if (!currentPage || (currentPage.blocks.length === 0 && status !== PageStatus.ERROR)) return;

    try {
      const updatedPages = [...dlm.pages];
      updatedPages[activePageIndex] = { ...currentPage, status: PageStatus.TRANSLATING };
      onUpdateDLM({ ...dlm, pages: updatedPages });

      const translations = await translateSegments(currentPage.blocks, targetLang);
      
      const updatedBlocks = currentPage.blocks.map(block => ({
        ...block,
        translated_text: translations[block.id] || block.source_text
      }));

      const finalPages = [...dlm.pages];
      finalPages[activePageIndex] = { 
          ...currentPage, 
          blocks: updatedBlocks, 
          status: PageStatus.TRANSLATED 
      };
      
      onUpdateDLM({ ...dlm, pages: finalPages });

    } catch (err) {
      console.error(err);
      const errorPages = [...dlm.pages];
      errorPages[activePageIndex] = { ...currentPage, status: PageStatus.ERROR };
      onUpdateDLM({ ...dlm, pages: errorPages });
    }
  };

  // Auto-trigger translation when layout analysis completes
  useEffect(() => {
    if (status === PageStatus.ANALYZED && currentPage.blocks.length > 0) {
      handleTranslatePage();
    }
  }, [status, activePageIndex]);

  const handleExport = (format: 'html' | 'docx') => {
    if (!dlm) return;
    const content = generateDocumentContent(dlm.pages, 'Translated Document');
    const timestamp = new Date().toISOString().slice(0, 10);
    
    if (format === 'html') {
      downloadFile(content, `nexttranslate-${timestamp}.html`, 'text/html');
    } else {
      downloadFile(content, `nexttranslate-${timestamp}.doc`, 'application/msword');
    }
    setShowExportMenu(false);
  };

  const handleCopy = async () => {
     if(!currentPage) return;
     const text = currentPage.blocks.map(b => b.translated_text || b.source_text).join('\n');
     await navigator.clipboard.writeText(text);
     setIsCopied(true);
     setTimeout(() => setIsCopied(false), 2000);
  };

  const getBoxStyle = (box: number[]) => {
    const top = box[0] / 10;
    const left = box[1] / 10;
    const height = (box[2] - box[0]) / 10;
    const width = (box[3] - box[1]) / 10;
    return { top: `${top}%`, left: `${left}%`, height: `${height}%`, width: `${width}%` };
  };

  const renderMath = (latex: string | null, text: string) => {
      if (latex && (window as any).katex) {
          try {
              const html = (window as any).katex.renderToString(latex, {
                  throwOnError: false,
                  displayMode: true
              });
              return <div dangerouslySetInnerHTML={{ __html: html }} />;
          } catch (e) {
              console.warn("KaTeX render error", e);
          }
      }
      return <div className="font-serif italic text-gray-800 text-center">{text}</div>;
  };

  // Common Block Renderer
  const renderSingleBlock = (block: DocumentBlock, context: 'flow' | 'table' = 'flow') => {
      const content = block.translated_text || block.source_text;
      const isHovered = hoveredBlockId === block.id;
      
      // Dynamic Styles based on original layout
      const fontSize = getEstimatedFontSize(block.box_2d);
      const textAlign = getTextAlignment(block.box_2d);
      const fontWeight = block.type === BlockType.HEADING ? 700 : 400;

      const style: React.CSSProperties = {
          fontSize: context === 'table' ? '0.85rem' : fontSize, // Enforce smaller font in tables for density
          textAlign: context === 'table' ? 'left' : textAlign,
          fontWeight,
          lineHeight: 1.3
      };

      const baseClass = `transition-colors duration-200 ${isHovered ? 'bg-blue-50 ring-2 ring-blue-200 rounded' : ''}`;

      return (
          <div 
              key={block.id} 
              onMouseEnter={() => setHoveredBlockId(block.id)}
              onMouseLeave={() => setHoveredBlockId(null)}
              className={`relative ${context === 'flow' ? 'mb-1' : ''} ${baseClass}`}
              style={style}
          >
              {block.type === BlockType.MATH_FORMULA ? (
                  <div className="my-1">{renderMath(block.math_metadata?.latex || null, content)}</div>
              ) : block.type === BlockType.IMAGE ? (
                  <div className="h-32 bg-gray-100 border-2 border-dashed border-gray-300 rounded flex items-center justify-center text-gray-400 text-xs">
                      [Image]
                  </div>
              ) : (
                 // Render standard text
                 <span>{content}</span>
              )}
          </div>
      );
  };

  return (
    <div className="w-full bg-gray-100 flex-1 flex flex-col">
      {/* Sticky Toolbar */}
      <div className={`bg-white border-b border-gray-200 px-6 py-3 flex flex-wrap items-center justify-between z-40 shadow-sm transition-all duration-200 ${isSticky ? 'fixed top-0 left-0 right-0' : ''}`}>
        <div className="flex items-center space-x-4">
           {/* Enhanced Back Button */}
           <button 
             onClick={onBack} 
             className="flex items-center space-x-2 px-3 py-2 rounded-lg text-gray-600 hover:bg-gray-100 hover:text-gray-900 transition-colors" 
             title="Upload New File"
           >
             <ArrowLeft className="w-4 h-4" />
             <span className="text-sm font-medium">Back</span>
           </button>
           
           <div className="h-6 w-px bg-gray-300 mx-1"></div>
          <div className="flex items-center space-x-2 bg-gray-100 rounded-lg p-1">
             <button onClick={() => onPageChange(activePageIndex - 1)} disabled={activePageIndex === 0} className="p-1 rounded hover:bg-white hover:shadow-sm disabled:opacity-30 disabled:cursor-not-allowed">
                <ChevronLeft className="w-4 h-4 text-gray-600" />
             </button>
             <span className="text-xs font-medium text-gray-600 px-2 min-w-[60px] text-center">
               Page {activePageIndex + 1} / {dlm.page_count}
             </span>
             <button onClick={() => onPageChange(activePageIndex + 1)} disabled={activePageIndex === dlm.page_count - 1} className="p-1 rounded hover:bg-white hover:shadow-sm disabled:opacity-30 disabled:cursor-not-allowed">
                <ChevronRight className="w-4 h-4 text-gray-600" />
             </button>
          </div>
          <div className="h-6 w-px bg-gray-300 mx-2"></div>
          <div className="flex items-center space-x-2">
             <span className="text-sm font-medium text-gray-600">Target:</span>
             <select value={targetLang} onChange={(e) => setTargetLang(e.target.value)} className="block w-32 rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 sm:text-sm p-1.5 border">
               {SUPPORTED_LANGUAGES.map(l => (<option key={l.code} value={l.code}>{l.name}</option>))}
             </select>
          </div>
        </div>
        <div className="flex items-center space-x-3 mt-2 sm:mt-0">
          <button onClick={handleTranslatePage} disabled={status === PageStatus.TRANSLATING || status === PageStatus.ANALYZING || (status === PageStatus.ERROR && currentPage.blocks.length === 0)} className={`flex items-center space-x-2 px-4 py-2 rounded-md text-sm font-medium text-white shadow-sm transition-colors ${status === PageStatus.TRANSLATING || status === PageStatus.ANALYZING ? 'bg-blue-400 cursor-not-allowed' : status === PageStatus.TRANSLATED ? 'bg-green-600 hover:bg-green-700' : status === PageStatus.ERROR && currentPage.blocks.length > 0 ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}>
            {status === PageStatus.TRANSLATING ? (<><Loader2 className="w-4 h-4 animate-spin" /><span>Translating...</span></>) : status === PageStatus.TRANSLATED ? (<><Check className="w-4 h-4" /><span>Translated</span></>) : status === PageStatus.ERROR && currentPage.blocks.length > 0 ? (<><RefreshCw className="w-4 h-4" /><span>Retry Translation</span></>) : (<><RefreshCw className="w-4 h-4" /><span>Translate Page</span></>)}
          </button>
          <button onClick={handleCopy} disabled={status !== PageStatus.TRANSLATED} className={`flex items-center space-x-2 px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium transition-colors ${status !== PageStatus.TRANSLATED ? 'opacity-50 cursor-not-allowed text-gray-400' : 'text-gray-700 hover:bg-gray-50'}`}>
            {isCopied ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}<span>{isCopied ? 'Copied' : 'Copy'}</span>
          </button>
          <div className="relative" ref={exportMenuRef}>
            <button onClick={() => setShowExportMenu(!showExportMenu)} className="flex items-center space-x-2 px-4 py-2 bg-white border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"><Download className="w-4 h-4" /><span>Export All</span></button>
            {showExportMenu && (<div className="absolute right-0 mt-2 w-48 bg-white rounded-md shadow-lg border border-gray-200 z-50 overflow-hidden"><div className="py-1"><button onClick={() => handleExport('html')} className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Export as HTML</button><button onClick={() => handleExport('docx')} className="block w-full text-left px-4 py-2 text-sm text-gray-700 hover:bg-gray-100">Export as Doc</button></div></div>)}
          </div>
        </div>
      </div>
      
      {isSticky && <div className="h-16" />}

      <div className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-6 lg:p-8 grid grid-cols-1 lg:grid-cols-2 gap-8 h-full min-h-[80vh]">
        
        {/* Left Panel (Original) - Unchanged */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col h-full relative">
          <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wider flex justify-between items-center">
            <span>Original Document (Page {activePageIndex + 1})</span>
            {status === PageStatus.ANALYZING && (<span className="flex items-center gap-1 text-blue-600"><span className="w-2 h-2 bg-blue-600 rounded-full animate-pulse"></span>Scanning</span>)}
          </div>
          <div className="relative flex-1 p-4 overflow-auto bg-gray-100 flex justify-center items-start group">
             {currentPage.image_data_url ? (
                <div ref={imageContainerRef} className="relative shadow-lg inline-block bg-white overflow-hidden" style={{ maxWidth: '100%' }}>
                   <img src={currentPage.image_data_url} alt={`Page ${activePageIndex + 1}`} className="max-w-full h-auto block" />
                   {status === PageStatus.ANALYZING && (<><div className="animate-scan"></div><div className="scan-overlay"></div></>)}
                   {currentPage.blocks.map((block) => (
                     <div key={block.id} onMouseEnter={() => setHoveredBlockId(block.id)} onMouseLeave={() => setHoveredBlockId(null)} className={`absolute border-2 transition-opacity duration-150 cursor-pointer ${hoveredBlockId === block.id ? 'border-blue-500 bg-blue-500/10 opacity-100' : 'border-transparent hover:border-blue-300 opacity-0 group-hover:opacity-100'}`} style={getBoxStyle(block.box_2d)} title={block.type} />
                   ))}
                </div>
             ) : (
                 <div className="flex flex-col items-center justify-center h-full text-gray-400">
                    {status === PageStatus.ANALYZING ? (<div className="flex flex-col items-center"><Loader2 className="w-8 h-8 animate-spin mb-2" /><p>Rendering Page...</p></div>) : (<p>Loading Page Image...</p>)}
                 </div>
             )}
          </div>
        </div>

        {/* Right Panel: Translation (ENHANCED LAYOUT) */}
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden flex flex-col h-full">
          <div className="bg-gray-50 px-4 py-2 border-b border-gray-200 flex justify-between items-center">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">Translated Layout</span>
            <div className="text-xs font-medium">
                {status === PageStatus.TRANSLATED && <span className="text-green-600">Completed</span>}
                {status === PageStatus.TRANSLATING && <span className="text-blue-600">Translating...</span>}
                {status === PageStatus.ANALYZING && <span className="text-gray-400">Reconstructing...</span>}
                {status === PageStatus.ERROR && <span className="text-red-600">Action Failed</span>}
            </div>
          </div>
          <div className="flex-1 p-8 overflow-auto bg-white relative">
            {/* The rendering container simulates a document page (A4-ish ratio if needed, but here just fluid) */}
            <div className="prose max-w-none text-slate-900 leading-normal" style={{ fontSize: '14px' }}>
                {renderNodes.length > 0 ? (
                    renderNodes.map((node, idx) => {
                        
                        // --- ROW GROUP (Header simulation) ---
                        if (node.type === 'row_group') {
                            return (
                                <div key={node.id} className="flex flex-wrap justify-between items-start mb-4 gap-4">
                                    {node.items.map(item => (
                                        <div key={item.id} className="flex-1 min-w-[30%]">
                                            {renderSingleBlock(item)}
                                        </div>
                                    ))}
                                </div>
                            );
                        }
                        
                        // --- TABLE (Strict Grid) ---
                        else if (node.type === 'table') {
                            const rows: Record<number, DocumentBlock[]> = {};
                            node.cells.forEach(cell => {
                                const r = cell.table_metadata?.row || 0;
                                if (!rows[r]) rows[r] = [];
                                rows[r].push(cell);
                            });

                            return (
                                <div key={`table-${node.id}`} className="mb-6">
                                    <table className="w-full border-collapse table-fixed border border-gray-300">
                                        <colgroup>
                                            {node.colWidths.map((w, i) => (
                                                <col key={i} style={{ width: `${w}%` }} />
                                            ))}
                                        </colgroup>
                                        <tbody>
                                            {Object.keys(rows).sort((a,b) => Number(a)-Number(b)).map(rowIndex => {
                                                const rId = Number(rowIndex);
                                                const rowCells = rows[rId].sort((a,b) => (a.table_metadata?.col || 0) - (b.table_metadata?.col || 0));
                                                
                                                return (
                                                    <tr key={rowIndex}>
                                                        {rowCells.map(cell => (
                                                            <td 
                                                                key={cell.id}
                                                                colSpan={cell.table_metadata?.col_span || 1}
                                                                rowSpan={cell.table_metadata?.row_span || 1}
                                                                onMouseEnter={() => setHoveredBlockId(cell.id)}
                                                                onMouseLeave={() => setHoveredBlockId(null)}
                                                                className={`border border-gray-400 p-1.5 align-top ${hoveredBlockId === cell.id ? 'bg-blue-50' : ''}`}
                                                            >
                                                                {renderSingleBlock(cell, 'table')}
                                                            </td>
                                                        ))}
                                                    </tr>
                                                )
                                            })}
                                        </tbody>
                                    </table>
                                </div>
                            );
                        }
                        
                        // --- LIST ---
                        else if (node.type === 'list') {
                            return (
                                <ul key={`list-${node.id}`} className="list-disc pl-5 mb-2 space-y-0.5">
                                    {node.items.map(item => (
                                        <li key={item.id}>
                                           {renderSingleBlock(item)}
                                        </li>
                                    ))}
                                </ul>
                            )
                        } 
                        
                        // --- STANDARD BLOCK ---
                        else if (node.type === 'block') {
                            return renderSingleBlock(node.data);
                        }
                        return null;
                    })
                ) : (
                    <div className="h-full flex flex-col items-center justify-center text-gray-400 space-y-2 w-full min-h-[400px]">
                        {status === PageStatus.ANALYZING ? (
                            <SkeletonLoader />
                        ) : status === PageStatus.ERROR ? (
                             <div className="flex flex-col items-center text-center p-6 bg-red-50 rounded-xl border border-red-100 max-w-sm">
                                 <div className="bg-red-100 p-3 rounded-full mb-3"><AlertCircle className="w-8 h-8 text-red-600" /></div>
                                 <h3 className="text-lg font-semibold text-gray-900 mb-2">Analysis Failed</h3>
                                 <p className="text-sm text-gray-600 mb-6">We couldn't recognize the layout. Try again or check the file.</p>
                                 <button onClick={onRetryAnalysis} className="flex items-center space-x-2 px-4 py-2 bg-red-600 text-white rounded-md text-sm font-medium hover:bg-red-700 transition-colors"><RefreshCw className="w-4 h-4" /><span>Retry Analysis</span></button>
                             </div>
                        ) : (
                            <p>Waiting for layout analysis...</p>
                        )}
                    </div>
                )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Workspace;