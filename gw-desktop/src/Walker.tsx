// Loaded lazily: this module pulls in Graphic Walker + Vega (~most of the bundle),
// so the window shell paints first and this chunk is parsed only when data is opened.
import { GraphicWalker } from '@kanaries/graphic-walker';
import type { IDarkMode, IGeoDataItem } from '@kanaries/graphic-walker';
import type { Dataset } from './data';
import { FEATURE_ID } from './geo';
import { askViz, vlChat } from './ai';

interface Props {
  dataset: Dataset;
  /** Boundary layers offered in Graphic Walker's choropleth "geo data" picker (blob: URLs). */
  geoList: IGeoDataItem[];
  appearance: IDarkMode;
  aiEnabled: boolean;
  /** Changes when the basemap source changes, so Graphic Walker's maps re-render with new tiles. */
  tileRevision: number;
}

export default function Walker({ dataset, geoList, appearance, aiEnabled, tileRevision }: Props) {
  const polygons = dataset.geo && dataset.geo.kind !== 'point' ? dataset.geo.collection : undefined;
  return (
    <GraphicWalker
      // Remount on new dataset so charts from the previous file don't leak across.
      key={`${dataset.id}:${tileRevision}`}
      data={dataset.rows}
      fields={dataset.fields}
      appearance={appearance}
      // A polygon layer can be drawn as a choropleth straight away: Geo ID = `_fid`.
      geographicData={polygons ? { type: 'GeoJSON', data: polygons, key: FEATURE_ID } : undefined}
      geoList={geoList}
      // Local computation runs in a web worker; allow time for multi-million-row files.
      computationTimeout={120000}
      enhanceAPI={aiEnabled ? { features: { askviz: askViz, vlChat } } : undefined}
    />
  );
}
