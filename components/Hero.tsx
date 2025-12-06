import React, { useCallback } from 'react';
import { UploadCloud, FileText, ScanEye, Maximize } from './ui/Icons';

interface HeroProps {
  onUpload: (file: File) => void;
}

const Hero: React.FC<HeroProps> = ({ onUpload }) => {
  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files && files.length > 0) {
      onUpload(files[0]);
    }
  };

  const features = [
    {
      icon: <ScanEye className="w-6 h-6 text-blue-600" />,
      title: "AI Layout Detection",
      desc: "Gemini Vision intelligently identifies tables, headers, and lists from scans."
    },
    {
      icon: <FileText className="w-6 h-6 text-indigo-600" />,
      title: "Contextual Translation",
      desc: "Translates block-by-block keeping semantic meaning intact."
    },
    {
      icon: <Maximize className="w-6 h-6 text-teal-600" />,
      title: "Split View Editor",
      desc: "Compare original document and translation side-by-side."
    }
  ];

  return (
    <div className="flex-1 flex flex-col items-center justify-center py-16 px-4 sm:px-6 lg:px-8 bg-gradient-to-b from-white to-gray-50">
      <div className="text-center max-w-3xl mx-auto mb-12">
        <div className="inline-block mb-4 px-3 py-1 bg-blue-50 border border-blue-100 text-blue-700 rounded-full text-xs font-semibold tracking-wide uppercase">
          Powered by Gemini 2.5 Flash
        </div>
        <h2 className="text-4xl sm:text-5xl font-extrabold text-gray-900 tracking-tight mb-6">
          Translate Documents,<br />
          <span className="text-blue-600">Preserve the Layout.</span>
        </h2>
        <p className="text-lg text-gray-600 mb-8 leading-relaxed">
          Upload a scanned PDF or image. Our AI reconstructs the layout and translates content seamlessly. 
          Perfect for contracts, research papers, and reports.
        </p>

        {/* Upload Area */}
        <div className="w-full max-w-xl mx-auto">
          <label 
            className="flex flex-col items-center justify-center w-full h-48 border-2 border-blue-200 border-dashed rounded-2xl cursor-pointer bg-blue-50/30 hover:bg-blue-50 transition-all group"
          >
            <div className="flex flex-col items-center justify-center pt-5 pb-6">
              <div className="bg-white p-3 rounded-full shadow-sm mb-3 group-hover:scale-110 transition-transform">
                <UploadCloud className="w-8 h-8 text-blue-500" />
              </div>
              <p className="mb-2 text-sm text-gray-700 font-semibold">
                Click to upload or drag and drop
              </p>
              <p className="text-xs text-gray-500">
                JPG, PNG, or PDF (Max 150MB)
              </p>
            </div>
            <input 
              type="file" 
              className="hidden" 
              accept="image/png, image/jpeg, image/jpg, application/pdf"
              onChange={handleFileChange}
            />
          </label>
        </div>
      </div>

      {/* Feature Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full px-4 mt-8">
        {features.map((f, i) => (
          <div key={i} className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm hover:shadow-md transition-shadow">
            <div className="mb-4 p-2 bg-gray-50 rounded-lg w-fit">
              {f.icon}
            </div>
            <h3 className="font-semibold text-gray-900 mb-2">{f.title}</h3>
            <p className="text-sm text-gray-500 leading-relaxed">
              {f.desc}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
};

export default Hero;