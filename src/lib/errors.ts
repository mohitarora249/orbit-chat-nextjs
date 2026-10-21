// Kept free of Next.js imports: it is also loaded by the custom server (server.ts) outside the Next runtime.
// Thrown inside route handlers (including from inside transactions) to return a specific status.
export class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}
