import { useMemo, useState } from 'react';
import { useAssets, AssetGrid, AssetDropzone } from '../components/AssetPicker';
import { Icon } from '../components/Icon';

export function Media() {
  const { assets, uploading, upload, remove } = useAssets();
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? assets.filter(a => a.filename.toLowerCase().includes(q)) : assets;
  }, [assets, query]);

  return (
    <>
      <div className="toolbar sticky-bar">
        <strong className="grow">Medien</strong>
        {assets.length > 0 && (
          <div className="searchbox" style={{ width: 240 }}>
            <Icon name="search" size={15} />
            <input placeholder="Dateiname …" value={query} onChange={e => setQuery(e.target.value)} />
          </div>
        )}
      </div>

      <div className="card">
        <AssetDropzone onFiles={upload} uploading={uploading} />
        <div className="muted small" style={{ marginTop: 12 }}>
          Bilder aus dieser Bibliothek werden beim Versand <strong>fest in die Mail eingebettet</strong> (als Inline-Anhang).
          Empfänger sehen sie also auch, wenn sie keinen Zugriff auf diesen Server haben.
        </div>
      </div>

      <div className="card">
        <div className="toolbar" style={{ marginBottom: 12 }}>
          <strong className="grow">Bibliothek ({shown.length}{query && ` von ${assets.length}`})</strong>
        </div>
        <AssetGrid assets={shown} onDelete={remove} />
      </div>
    </>
  );
}
