/** Types for the e2e, which runs this example's own build. */
export function build(options?: {
  out?: string;
  tsconfig?: string;
}): Promise<string>;
