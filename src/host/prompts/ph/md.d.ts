/** `.md` files are bundled as text (tsdown `loader`, vitest `md-text` plugin). */
declare module '*.md' {
  const text: string
  export default text
}
