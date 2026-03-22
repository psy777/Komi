import React, { useState } from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import ImageScorer from './ImageScorer';

type Page = 'editor' | 'scorer';

const Root: React.FC = () => {
  const [page, setPage] = useState<Page>('editor');

  if (page === 'scorer') {
    return <ImageScorer onBack={() => setPage('editor')} />;
  }

  return <App onOpenScorer={() => setPage('scorer')} />;
};

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

const root = ReactDOM.createRoot(rootElement);
root.render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>
);
