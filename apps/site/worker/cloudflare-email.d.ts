// The one Workers-runtime module the Worker imports. Declared by hand rather than pulling in the
// full @cloudflare/workers-types package for a single class.
declare module 'cloudflare:email' {
  export class EmailMessage {
    constructor(from: string, to: string, raw: string | ReadableStream);
    readonly from: string;
    readonly to: string;
  }
}
