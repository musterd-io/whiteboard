/**
 * The browser page a human draws on. Board name comes from the path (/b/<name>); the page
 * joins the same sync room the agent writes into, so both sides see every stroke live.
 */
import { useSync } from '@tldraw/sync';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { Tldraw, defaultShapeUtils, defaultBindingUtils } from 'tldraw';
import type { TLAssetStore } from 'tldraw';
import 'tldraw/tldraw.css';

// Boards are text-first (notes, arrows, frames); pasted assets stay local to the browser as
// data URLs rather than needing an upload server. Good enough until image reads (increment 2).
const inlineAssets: TLAssetStore = {
  upload: async (_asset, file) => {
    const src = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(new Error('failed to read file'));
      reader.readAsDataURL(file);
    });
    return { src };
  },
  resolve: (asset) => asset.props.src,
};

function boardName(): string {
  const match = window.location.pathname.match(/^\/b\/([^/]+)$/);
  return match?.[1] ?? 'scratch';
}

function App() {
  const board = boardName();
  const store = useSync({
    uri: `ws://${window.location.host}/ws/${board}`,
    assets: inlineAssets,
    shapeUtils: defaultShapeUtils,
    bindingUtils: defaultBindingUtils,
  });
  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw store={store} />
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
