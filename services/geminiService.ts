import { GoogleGenAI, Type } from "@google/genai";
import { BlockType, DocumentBlock } from '../types';
import * as pdfjsLib from 'pdfjs-dist';

// Initialize the Gemini client
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

const LAYOUT_MODEL = 'gemini-2.5-flash';
const TRANSLATION_MODEL = 'gemini-2.5-flash';

// Configure PDF.js worker for client-side rasterization
// CRITICAL FIX: Only configure worker in browser environment to prevent Vercel Build/SSR errors
if (typeof window !== 'undefined' && pdfjsLib.GlobalWorkerOptions) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.0.379/build/pdf.worker.min.mjs';
}

/**
 * Helper function to safely parse JSON from LLM output.
 * Fixes common issues like Markdown code blocks and unescaped control characters in strings.
 */
const cleanAndParseJSON = (text: string): any => {
  if (!text) return {};
  
  // 1. Remove markdown code blocks
  let cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  
  // 2. Extract JSON object if there's preamble/postamble
  const firstOpen = cleaned.indexOf('{');
  const lastClose = cleaned.lastIndexOf('}');
  if (firstOpen !== -1 && lastClose !== -1) {
      cleaned = cleaned.substring(firstOpen, lastClose + 1);
  }

  // 3. Fix Bad Control Characters in strings
  // Replaces literal control characters (like \n, \t) inside strings with their escaped versions (\\n, \\t)
  // Regex matches JSON strings: " ( anything that is not " or \ OR an escaped char )* "
  cleaned = cleaned.replace(/"(?:[^\\"]|\\.)*"/g, (match) => {
      return match.replace(/[\u0000-\u001F]/g, (char) => {
           const map: Record<string, string> = {
              '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t'
          };
          return map[char] || ('\\u' + char.charCodeAt(0).toString(16).padStart(4, '0'));
      });
  });

  return JSON.parse(cleaned);
};

/**
 * Get basic details about the document.
 * Returns page count and determines type.
 */
export const getDocumentDetails = async (base64DataUrl: string): Promise<{ type: 'pdf' | 'image', pageCount: number }> => {
    if (base64DataUrl.startsWith('data:application/pdf')) {
        const loadingTask = pdfjsLib.getDocument(base64DataUrl);
        const pdf = await loadingTask.promise;
        return { type: 'pdf', pageCount: pdf.numPages };
    } else {
        return { type: 'image', pageCount: 1 };
    }
};

/**
 * Rasterize a specific page of a PDF to a JPEG Base64 string.
 * Page numbers are 1-based.
 */
export const rasterizePdfPage = async (pdfBase64: string, pageNumber: number): Promise<string> => {
    // Safety check for SSR
    if (typeof document === 'undefined') {
        throw new Error("Cannot rasterize PDF on server side");
    }

    try {
        const loadingTask = pdfjsLib.getDocument(pdfBase64);
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(pageNumber);

        // Scale 2.0 provides better OCR accuracy (~150-200 DPI equivalent)
        const viewport = page.getViewport({ scale: 2.0 });

        const canvas = document.createElement('canvas');
        const context = canvas.getContext('2d');

        if (!context) throw new Error("Failed to create canvas context");

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        // Cast to any to avoid TypeScript error about missing 'canvas' property in RenderParameters
        await page.render({ canvasContext: context, viewport } as any).promise;

        // Convert to JPEG image with 0.8 quality to optimize payload
        return canvas.toDataURL('image/jpeg', 0.8);
    } catch (e) {
        console.error("PDF Rasterization failed for page " + pageNumber, e);
        throw new Error("Failed to render PDF page.");
    }
};

const getImageDimensions = (base64Image: string): Promise<{ width: number; height: number }> => {
  return new Promise((resolve, reject) => {
    if (typeof Image === 'undefined') {
        resolve({ width: 1000, height: 1414 }); // Fallback for SSR
        return;
    }
    const img = new Image();
    img.onload = () => resolve({ width: img.width, height: img.height });
    img.onerror = reject;
    img.src = base64Image;
  });
};

/**
 * STAGE 1: Layout Analysis & OCR (Single Page)
 * Analyzes a single image (already rasterized if it was a PDF).
 */
export const analyzePageLayout = async (base64Image: string): Promise<DocumentBlock[]> => {
  try {
    // Parse Data URL to extract MIME type and Base64 data
    const matches = base64Image.match(/^data:([^;]+);base64,(.+)$/);
    
    if (!matches || matches.length !== 3) {
      throw new Error("Invalid data URL format. Expected 'data:mime/type;base64,...'");
    }

    const mimeType = matches[1];
    const base64Data = matches[2];
    
    const { width, height } = await getImageDimensions(base64Image);

    const systemPrompt = `
      Bạn là AI chuyên gia OCR + Hiểu bố cục tài liệu (Document Layout Understanding AI).

      Nhiệm vụ của bạn:

      1. Nhận đầu vào là MỘT TRANG tài liệu (hình ảnh trang PDF đã raster).
      2. Phân tích và TRẢ VỀ KẾT QUẢ DUY NHẤT dưới dạng JSON, mô tả:
         - Các CONTAINER (vùng nội dung lớn): cột, box cảnh báo, phần thân, header/footer.
         - Các BLOCK văn bản: heading, đoạn văn, gạch đầu dòng, cell của bảng, chú thích ảnh.
         - Các BẢNG (table), kể cả bảng không có đường kẻ.
         - Các CÔNG THỨC TOÁN (math formula), ưu tiên ở dạng LaTeX.
      3. KHÔNG dịch, KHÔNG tóm tắt, KHÔNG thêm/bớt nội dung.

      Bạn phải:
      - Tôn trọng tối đa bố cục thị giác gốc.
      - Xác định đúng THỨ TỰ ĐỌC (reading order) của các block.
      - Luôn gán mỗi block vào đúng CONTAINER chứa nó.

      Nếu bạn không chắc chắn về một chi tiết, vẫn phải cố gắng suy luận và ghi lại với confidence thấp hơn, không được bỏ qua hẳn.
    `;

    const requestPrompt = `
      ĐÂY LÀ YÊU CẦU CHO MỘT TRANG DUY NHẤT.

      Đầu vào:
      - Một hình ảnh trang PDF (page image) đã được raster hóa.
      - Kích thước ảnh: ${width} x ${height} px (tính từ hệ thống, chỉ để tham khảo).

      Mục tiêu:
      - Trích xuất bố cục và nội dung của TRANG NÀY
      - Tuân theo cấu trúc JSON của Document Layout Model v2 (DLM v2) như sau.

      [ĐỊNH NGHĨA JSON OUTPUT]

      Bạn PHẢI trả về MỘT JSON object có dạng:

      {
        "page_number": 1,
        "size": {
          "width": number,
          "height": number,
          "unit": "px"
        },
        "containers": [
          {
            "container_id": string,
            "container_type": "column" | "body" | "warning_box" | "caution_box" | "image_box" | "footer" | "header",
            "bbox": [x, y, width, height]
          }
        ],
        "blocks": [
          {
            "block_id": string,
            "container_id": string,
            "type": "heading" | "paragraph" | "list_item" | "table_cell" | "caption" | "label" | "math_formula",
            "role": string | null,
            "bbox": [x, y, width, height],
            "reading_order": number,
            "source": {
              "text": string         // văn bản OCR gốc của block
            },
            "list_structure": {
              "level": number,
              "ordered": boolean,
              "marker_text": string | null
            } | null,
            "table_structure": {
              "table_id": string,
              "row": number,
              "col": number,
              "row_span": number,
              "col_span": number
            } | null,
            "math": {
              "latex": string | null
            } | null
          }
        ],
        "images": [
          {
            "image_id": string,
            "bbox": [x, y, width, height],
            "caption_block_id": string | null
          }
        ]
      }

      [QUY TẮC NHẬN DIỆN CONTAINER]
      1. CONTAINER là vùng lớn hơn chứa nhiều block.
      2. Nhận diện tối thiểu các loại: "column", "body", "warning_box", "caution_box", "image_box".
      3. Mỗi block text PHẢI có 'container_id' tương ứng.

      [QUY TẮC NHẬN DIỆN LIST]
      - Nếu đoạn có bullet, số thứ tự, hoặc indent dạng danh sách: type = "list_item".

      [QUY TẮC NHẬN DIỆN BẢNG (TABLE) – RẤT QUAN TRỌNG]
      1. Bảng có thể có đường kẻ hoặc KHÔNG có đường kẻ.
      2. Nếu nhiều đoạn text nằm trên cùng một dòng ngang, hoặc xếp thành nhiều cột rất thẳng hàng, hãy xử lý chúng như một bảng.
      3. Với MỖI Ô BẢNG (cell): Tạo 1 block với type = "table_cell" và đầy đủ table_structure.

      [QUY TẮC NHẬN DIỆN CÔNG THỨC TOÁN (MATH)]
      1. Nếu thấy biểu thức toán học, ĐẶT type = "math_formula".
      2. Trong 'source.text', ghi lại biểu thức ở dạng dễ đọc.
      3. Trong 'math.latex', chuyển biểu thức sang LaTeX đúng chuẩn (ví dụ: \\sum_{i=1}^{n}).

      [QUY TẮC THỨ TỰ ĐỌC]
      - 'reading_order' là số nguyên bắt đầu từ 0, đi từ trên xuống dưới, trái sang phải.

      [ĐẦU RA]
      - Chỉ trả về JSON đúng format trên.
    `;

    const response = await ai.models.generateContent({
      model: LAYOUT_MODEL,
      contents: {
        parts: [
          { inlineData: { mimeType: mimeType, data: base64Data } },
          { text: systemPrompt + "\n\n" + requestPrompt }
        ]
      },
      config: {
        responseMimeType: 'application/json',
        // We use strict schema to ensure better type safety
        responseSchema: {
            type: Type.OBJECT,
            properties: {
                blocks: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            block_id: { type: Type.STRING },
                            type: { type: Type.STRING, enum: Object.values(BlockType) },
                            container_id: { type: Type.STRING, nullable: true },
                            bbox: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                            source: { 
                                type: Type.OBJECT, 
                                properties: { text: { type: Type.STRING } } 
                            },
                            list_structure: {
                                type: Type.OBJECT,
                                nullable: true,
                                properties: {
                                    level: { type: Type.INTEGER },
                                    ordered: { type: Type.BOOLEAN },
                                    marker_text: { type: Type.STRING, nullable: true }
                                }
                            },
                            table_structure: {
                                type: Type.OBJECT,
                                nullable: true,
                                properties: {
                                    table_id: { type: Type.STRING },
                                    row: { type: Type.INTEGER },
                                    col: { type: Type.INTEGER },
                                    row_span: { type: Type.INTEGER },
                                    col_span: { type: Type.INTEGER }
                                }
                            },
                            math: {
                                type: Type.OBJECT,
                                nullable: true,
                                properties: {
                                    latex: { type: Type.STRING, nullable: true }
                                }
                            }
                        },
                        required: ['block_id', 'type', 'bbox', 'source']
                    }
                },
                images: {
                    type: Type.ARRAY,
                    items: {
                        type: Type.OBJECT,
                        properties: {
                            image_id: { type: Type.STRING },
                            bbox: { type: Type.ARRAY, items: { type: Type.NUMBER } },
                            caption_block_id: { type: Type.STRING, nullable: true }
                        }
                    }
                }
            }
        }
      }
    });

    const result = cleanAndParseJSON(response.text || '{ "blocks": [], "images": [] }');

    // Map JSON result to internal DocumentBlock
    const mappedBlocks: DocumentBlock[] = [];

    if (result.blocks) {
        result.blocks.forEach((b: any) => {
            // Normalize BBox [x, y, w, h] -> [ymin, xmin, ymax, xmax] (0-1000)
            const x = b.bbox[0];
            const y = b.bbox[1];
            const w = b.bbox[2];
            const h = b.bbox[3];

            const ymin = Math.round((y / height) * 1000);
            const xmin = Math.round((x / width) * 1000);
            const ymax = Math.round(((y + h) / height) * 1000);
            const xmax = Math.round(((x + w) / width) * 1000);

            mappedBlocks.push({
                id: b.block_id,
                type: b.type,
                box_2d: [ymin, xmin, ymax, xmax],
                source_text: b.source?.text || "",
                container_id: b.container_id,
                table_metadata: b.table_structure ? {
                    table_id: b.table_structure.table_id,
                    row: b.table_structure.row,
                    col: b.table_structure.col,
                    row_span: b.table_structure.row_span || 1,
                    col_span: b.table_structure.col_span || 1
                } : undefined,
                math_metadata: b.math ? {
                    latex: b.math.latex
                } : undefined,
                list_metadata: b.list_structure ? {
                    level: b.list_structure.level,
                    ordered: b.list_structure.ordered,
                    marker: b.list_structure.marker_text
                } : undefined
            });
        });
    }

    // Add Images as blocks
    if (result.images) {
        result.images.forEach((img: any) => {
            const x = img.bbox[0];
            const y = img.bbox[1];
            const w = img.bbox[2];
            const h = img.bbox[3];
            
            const ymin = Math.round((y / height) * 1000);
            const xmin = Math.round((x / width) * 1000);
            const ymax = Math.round(((y + h) / height) * 1000);
            const xmax = Math.round(((x + w) / width) * 1000);

            mappedBlocks.push({
                id: img.image_id,
                type: BlockType.IMAGE,
                box_2d: [ymin, xmin, ymax, xmax],
                source_text: "[Image]",
                container_id: "image_box" // generic container for images
            });
        });
    }

    return mappedBlocks;

  } catch (error) {
    console.error("Layout Analysis Error:", error);
    throw error;
  }
};

/**
 * Heuristic to check if a Table Cell should be translated or copied.
 * Rules TC2, TC3, TC4, TC8: Do not translate symbols, units, math-only cells.
 */
const shouldTranslateTableCell = (text: string): boolean => {
    const trimmed = text.trim();
    
    // Empty or pure numbers
    if (!trimmed || /^[\d\.,\s-]+$/.test(trimmed)) return false;

    // Common Math/Physics Symbols (Short patterns, Greek, Variables)
    // e.g. x, x(i), a_j, \Delta, Σ
    if (/^[a-zA-Z0-9_α-ωΑ-Ω\+\-\*\/=\(\)\[\]\{\}<>\.,!@#\$%\^&\|~'"]{1,6}$/.test(trimmed)) return false;
    
    // Variable patterns specifically: a_j, x(i), V_rms
    if (/^[a-zA-Z][a-zA-Z0-9]*(_\{?[a-zA-Z0-9]+\}?|\([a-zA-Z0-9,\+\-]+\))$/.test(trimmed)) return false;

    // Units (Simple check) - e.g. 10 V, 50 Hz, 100 kΩ, 20%
    // Matches number followed by unit
    if (/^[\d\.,\s\+\-]+(mA|A|V|kV|mV|Hz|kHz|MHz|GHz|Ω|kΩ|MΩ|dB|ms|µs|s|ns|°C|°F|K|%|ppm|mol|g|kg)$/i.test(trimmed)) return false;

    // LaTeX expressions
    if (trimmed.includes('\\') || trimmed.includes('^{') || trimmed.includes('_{')) return false;

    // Short uppercase codes (likely IDs or status)
    if (/^[A-Z0-9\-_]{1,4}$/.test(trimmed)) return false;

    return true;
}

/**
 * STAGE 2: Translation Engine
 * Translates text segments while preserving context.
 */
export const translateSegments = async (
  blocks: DocumentBlock[], 
  targetLanguage: string
): Promise<Record<string, string>> => {
  try {
    const translationMap: Record<string, string> = {};

    // RULE T1: Separate Translatable vs Non-Translatable (Math/Image)
    const textBlocks = blocks.filter(b => {
      // Always exclude Images
      if (b.type === BlockType.IMAGE) return false;

      // Always exclude pure Math Formulas (Rule T2)
      if (b.type === BlockType.MATH_FORMULA) {
          // Copy source text or Latex (Rule T3)
          translationMap[b.id] = b.math_metadata?.latex || b.source_text;
          return false;
      }

      // Special handling for Table Cells (TC Rules)
      if (b.type === BlockType.TABLE_CELL) {
          if (!shouldTranslateTableCell(b.source_text)) {
              // TC4: Copy symbol/unit only cells
              translationMap[b.id] = b.source_text;
              return false;
          }
      }
      
      return b.source_text.trim().length > 0;
    });

    // If no text blocks to translate, return just the math/static blocks
    if (textBlocks.length === 0) return translationMap;

    // Prepare payload for Gemini
    const payload = textBlocks.map(b => ({
      id: b.id,
      type: b.type,
      text: b.source_text,
      context: b.type === BlockType.TABLE_CELL ? 'Table cell content - technical context' : undefined
    }));

    // Translation Prompt enforcing Rules TC5, TC9
    const prompt = `
      You are a professional technical translator.
      Translate the "text" field of each object below into ${targetLanguage}.
      
      General Rules:
      1. Maintain original tone and meaning.
      2. If type is "heading", keep it concise.
      3. Do not translate IDs.

      Specific Rules for 'table_cell' (TC Rules):
      TC5. If text is a technical description, translate accurately but concisely. Do not add explanations.
      TC9. Do NOT translate technical keywords (e.g. 'Savitzky-Golay', 'Gaussian', 'Fourier', 'Kalman Filter'), API names, or File formats.
      TC7. Preserve multiline structure if present.
      TC2/TC3. If a variable or unit appears in the text (e.g. "Input Voltage (V)"), keep the variable/unit in English/Symbol.
      
      Return a JSON object with a "translations" array containing { "id": "...", "translated_text": "..." }.
      
      Input Data:
      ${JSON.stringify(payload)}
    `;

    const response = await ai.models.generateContent({
      model: TRANSLATION_MODEL,
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            translations: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  id: { type: Type.STRING },
                  translated_text: { type: Type.STRING }
                },
                required: ['id', 'translated_text']
              }
            }
          }
        }
      }
    });

    const result = cleanAndParseJSON(response.text || '{ "translations": [] }');
    
    // Merge AI translations
    result.translations.forEach((t: any) => {
      translationMap[t.id] = t.translated_text;
    });

    return translationMap;

  } catch (error) {
    console.error("Translation Error:", error);
    throw new Error("Failed to translate segments.");
  }
};