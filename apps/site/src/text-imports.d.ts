// The build imports HTML partials and fragment CSS as plain strings (esbuild's `text` loader).
declare module '*.html' {
  const text: string;
  export default text;
}

declare module '*.css' {
  const text: string;
  export default text;
}
