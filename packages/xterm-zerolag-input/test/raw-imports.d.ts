/** Vite `?raw` imports used by replay-helpers.ts (fixture JSONL as strings). */
declare module '*.jsonl?raw' {
  const content: string;
  export default content;
}
