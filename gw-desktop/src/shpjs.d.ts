declare module 'shpjs' {
  import type { FeatureCollection } from 'geojson';
  type Buf = ArrayBuffer | ArrayBufferView;
  type Parsed = FeatureCollection & { fileName?: string };
  export default function getShapefile(
    input: Buf | { shp: Buf; dbf?: Buf; prj?: Buf | string; cpg?: Buf | string },
  ): Promise<Parsed | Parsed[]>;
}
