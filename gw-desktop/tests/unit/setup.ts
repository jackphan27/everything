// jsdom has no canvas; Vega probes one when Graphic Walker is imported. Tests never draw.
if (typeof HTMLCanvasElement !== 'undefined') {
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
}
