// Loaded lazily: this module pulls in Graphic Walker + Vega (~most of the bundle),
// so the window shell paints first and this chunk is parsed only when data is opened.
import { GraphicWalker } from '@kanaries/graphic-walker';
import type { IDarkMode } from '@kanaries/graphic-walker';
import type { Dataset } from './data';
import { askViz, vlChat } from './ai';

interface Props {
  dataset: Dataset;
  appearance: IDarkMode;
  aiEnabled: boolean;
}

export default function Walker({ dataset, appearance, aiEnabled }: Props) {
  return (
    <GraphicWalker
      // Remount on new dataset so charts from the previous file don't leak across.
      key={dataset.name + dataset.rows.length}
      data={dataset.rows}
      fields={dataset.fields}
      appearance={appearance}
      // Local computation runs in a web worker; allow time for multi-million-row files.
      computationTimeout={120000}
      enhanceAPI={aiEnabled ? { features: { askviz: askViz, vlChat } } : undefined}
    />
  );
}
