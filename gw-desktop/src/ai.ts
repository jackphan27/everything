import { normalize, projectTerse } from '@kanaries/graphic-walker';
import type { IChart, IChatMessage, IMutField, IViewField } from '@kanaries/graphic-walker';
import { aiChat, type ChatMsg } from './settings';

// Only field metadata (names + types) is sent to the model — never row data.
const SYSTEM_PROMPT = `You turn questions about a dataset into a chart spec for Graphic Walker.
Reply with ONE JSON object only (no prose, no code fences) in this "terse spec" format:
{
  "mark": "auto|bar|line|area|point|circle|tick|rect|arc|text|boxplot|table",
  "name": "short chart title",
  "x": FieldRef | FieldRef[],   "y": FieldRef | FieldRef[],
  "color"?: FieldRef, "size"?: FieldRef, "opacity"?: FieldRef, "shape"?: FieldRef,
  "text"?: FieldRef, "theta"?: FieldRef, "details"?: FieldRef[],
  "filters"?: [{"field": "Name", "oneOf": [..]} | {"field": "Name", "range": [min|null, max|null]}],
  "computed"?: [{"name": "New field", "expr": "sql expression over fields"}],
  "aggregate"?: true, "stack"?: "stack|normalize|center|none", "sort"?: "ascending|descending", "limit"?: 10
}
FieldRef is a field name exactly as listed, or an aggregate shorthand like "sum(Sales)", "mean(Price)", or "count()" for the row count,
or {"field": "Order Date", "timeUnit": "year|quarter|month|week|day"}.
Aggregates: sum, count, mean, median, min, max, variance, stdev, distinctCount.
Use "arc" + "theta" + "color" for pie charts. Only use fields from the list.`;

// Graphic Walker injects built-in fields (row count, measure names/values) with a `gw_` prefix;
// `normalize()` re-adds them itself, so passing them through produces duplicate fids.
const isDataField = (m: IViewField) => !m.computed && !m.fid.startsWith('gw_');

function describeFields(metas: IViewField[]): string {
  return metas
    .filter(isDataField)
    .map((m) => `- ${m.name ?? m.fid} (${m.analyticType}, ${m.semanticType})`)
    .join('\n');
}

function toMutFields(metas: IViewField[]): IMutField[] {
  return metas
    .filter(isDataField)
    .map((m) => ({ fid: m.fid, name: m.name, semanticType: m.semanticType, analyticType: m.analyticType }));
}

function extractJson(text: string): object {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error(`The model did not return JSON:\n${text.slice(0, 400)}`);
  return JSON.parse(body.slice(start, end + 1));
}

function toChart(reply: string, metas: IViewField[]): IChart {
  // Models often write SQL-style count(*); terse spells the row count as count().
  const spec = extractJson(reply.replace(/count\(\s*\*\s*\)/gi, 'count()')) as Record<string, unknown>;
  // Force terse detection even if the model omits x/y (e.g. pie charts).
  spec.$schema = 'https://graphic-walker.kanaries.net/tersespec_v1.json';
  return normalize(spec, toMutFields(metas));
}

/** `enhanceAPI.features.askviz` — single-shot question → chart. */
export async function askViz(metas: IViewField[], query: string): Promise<IChart> {
  const messages: ChatMsg[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Fields:\n${describeFields(metas)}\n\nQuestion: ${query}` },
  ];
  return toChart(await aiChat(messages), metas);
}

/** `enhanceAPI.features.vlChat` — multi-turn chat that refines the chart. */
export async function vlChat(metas: IViewField[], chats: IChatMessage[]): Promise<IChart> {
  const messages: ChatMsg[] = [
    { role: 'system', content: `${SYSTEM_PROMPT}\n\nFields:\n${describeFields(metas)}` },
  ];
  for (const c of chats) {
    if (c.role === 'user') messages.push({ role: 'user', content: c.content });
    else {
      let terse: unknown;
      try { terse = projectTerse(c.chart); } catch { terse = { name: c.chart.name }; }
      messages.push({ role: 'assistant', content: JSON.stringify(terse) });
    }
  }
  return toChart(await aiChat(messages), metas);
}
