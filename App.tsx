import React, { useState, useCallback } from 'react';
import Layout from './components/Layout';
import Hero from './components/Hero';
import Workspace from './components/Workspace';
import { getDocumentDetails, rasterizePdfPage, analyzePageLayout } from './services/geminiService';
import { PageStatus, DLM, DocumentPage } from './types';

const App: React.FC = () => {
  const [dlm, setDlm] = useState<DLM | null>(null);
  const [activePageIndex, setActivePageIndex] = useState<number>(0);
  const [isInitializing, setIsInitializing] = useState(false);

  const handleUpload = async (file: File) => {
    try {
      setIsInitializing(true);
      
      const reader = new FileReader();
      reader.onload = async (e) => {
        const base64 = e.target?.result as string;
        
        try {
          // 1. Get Document Details (Count pages)
          const details = await getDocumentDetails(base64);
          
          // 2. Initialize DLM Structure
          const initialPages: DocumentPage[] = Array.from({ length: details.pageCount }, (_, i) => ({
            page_number: i + 1,
            blocks: [],
            status: PageStatus.IDLE
          }));

          const newDlm: DLM = {
            document_id: crypto.randomUUID(),
            file_type: details.type,
            source_data_url: base64,
            page_count: details.pageCount,
            pages: initialPages
          };

          setDlm(newDlm);
          setActivePageIndex(0);
          
          // 3. Process the First Page immediately
          await processPage(newDlm, 0);

        } catch (error) {
          console.error(error);
          alert("Failed to initialize document.");
        } finally {
          setIsInitializing(false);
        }
      };
      reader.readAsDataURL(file);

    } catch (error) {
      console.error("Upload error", error);
      setIsInitializing(false);
    }
  };

  // Core function to handle Layout Analysis for a specific page
  const processPage = async (currentDlm: DLM, pageIndex: number) => {
    if (!currentDlm) return;
    
    const pageNum = pageIndex + 1;
    let updatedDlm = { ...currentDlm };
    
    // Update status to Analyzing
    updatedDlm.pages = updatedDlm.pages.map((p, i) => 
      i === pageIndex ? { ...p, status: PageStatus.ANALYZING } : p
    );
    setDlm(updatedDlm);

    try {
      // A. Get Image (Rasterize if PDF and not yet done)
      let imageUrl = updatedDlm.pages[pageIndex].image_data_url;
      
      if (!imageUrl && updatedDlm.file_type === 'pdf') {
        imageUrl = await rasterizePdfPage(updatedDlm.source_data_url, pageNum);
      } else if (!imageUrl && updatedDlm.file_type === 'image') {
        imageUrl = updatedDlm.source_data_url;
      }

      if (!imageUrl) throw new Error("Failed to obtain page image");

      // B. Analyze Layout
      const blocks = await analyzePageLayout(imageUrl);

      // C. Update DLM State
      setDlm(prev => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex] = {
          ...newPages[pageIndex],
          blocks: blocks,
          image_data_url: imageUrl, // Cache the image
          status: PageStatus.ANALYZED
        };
        return { ...prev, pages: newPages };
      });

    } catch (err) {
      console.error(`Error processing page ${pageNum}:`, err);
      setDlm(prev => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex] = { ...newPages[pageIndex], status: PageStatus.ERROR };
        return { ...prev, pages: newPages };
      });
    }
  };

  const handlePageChange = async (newIndex: number) => {
    if (!dlm || newIndex < 0 || newIndex >= dlm.page_count) return;
    
    setActivePageIndex(newIndex);

    const targetPage = dlm.pages[newIndex];

    // If page hasn't been rasterized or analyzed, trigger processing
    if (targetPage.status === PageStatus.IDLE || !targetPage.image_data_url) {
       await processPage(dlm, newIndex);
    }
  };

  const handleRetryAnalysis = useCallback(async () => {
    if (dlm) {
      await processPage(dlm, activePageIndex);
    }
  }, [dlm, activePageIndex]);

  const handleReset = () => {
    setDlm(null);
    setActivePageIndex(0);
  };

  return (
    <Layout onLogoClick={handleReset}>
      {!dlm ? (
        <Hero onUpload={handleUpload} />
      ) : (
        <Workspace 
          dlm={dlm} 
          activePageIndex={activePageIndex}
          onPageChange={handlePageChange}
          onUpdateDLM={setDlm}
          onBack={handleReset}
          onRetryAnalysis={handleRetryAnalysis}
        />
      )}
    </Layout>
  );
};

export default App;