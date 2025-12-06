import React from 'react';
import { Languages } from './ui/Icons';

interface LayoutProps {
  children: React.ReactNode;
  onLogoClick?: () => void;
}

const Layout: React.FC<LayoutProps> = ({ children, onLogoClick }) => {
  return (
    <div className="min-h-screen bg-gray-50 text-slate-900 flex flex-col">
      {/* Navbar */}
      <header className="bg-white border-b border-gray-200 sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div 
              className={`flex items-center space-x-2 ${onLogoClick ? 'cursor-pointer hover:opacity-80 transition-opacity' : ''}`}
              onClick={onLogoClick}
            >
              <div className="bg-blue-600 p-2 rounded-lg">
                <Languages className="w-5 h-5 text-white" />
              </div>
              <h1 className="text-xl font-bold tracking-tight text-gray-900">
                NextTranslate <span className="text-blue-600">AI</span>
              </h1>
            </div>
          </div>
          <nav className="flex items-center space-x-6">
            <a href="#" className="text-sm font-medium text-gray-500 hover:text-gray-900">Features</a>
            <a href="#" className="text-sm font-medium text-gray-500 hover:text-gray-900">Pricing</a>
            <a href="#" className="text-sm font-medium text-gray-500 hover:text-gray-900">Enterprise</a>
            <button className="text-sm font-semibold bg-slate-900 text-white px-4 py-2 rounded-md hover:bg-slate-800 transition-colors">
              Sign In
            </button>
          </nav>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-grow flex flex-col">
        {children}
      </main>

      {/* Footer */}
      <footer className="bg-white border-t border-gray-200 py-8 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center text-sm text-gray-500">
          <p>© 2025 NextTranslate AI.</p>
        </div>
      </footer>
    </div>
  );
};

export default Layout;