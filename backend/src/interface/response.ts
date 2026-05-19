import { ZodError } from 'zod';
import { ErrorResponseDtoFactory } from './dto/error-response.dto.js';

export interface HttpResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function defaultHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
  };
}

export interface OkOptions {
  /** Set `Cache-Control` on the response. Use `'no-store'` to opt out. */
  cacheControl?: string;
  /** Additional headers to merge on top of the JSON content type. */
  headers?: Record<string, string>;
}

export const Response = {
  ok(data: unknown, opts: OkOptions = {}): HttpResponse {
    const headers: Record<string, string> = { ...defaultHeaders() };
    if (opts.cacheControl) headers['Cache-Control'] = opts.cacheControl;
    if (opts.headers) Object.assign(headers, opts.headers);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(data),
    };
  },

  created(data: unknown): HttpResponse {
    return {
      statusCode: 201,
      headers: defaultHeaders(),
      body: JSON.stringify(data),
    };
  },

  noContent(): HttpResponse {
    return {
      statusCode: 204,
      headers: {},
      body: '',
    };
  },

  badRequest(title: string, detail?: string): HttpResponse {
    return {
      statusCode: 400,
      headers: defaultHeaders(),
      body: JSON.stringify(ErrorResponseDtoFactory.create(400, title, detail)),
    };
  },

  unauthorized(title: string, detail?: string): HttpResponse {
    return {
      statusCode: 401,
      headers: defaultHeaders(),
      body: JSON.stringify(ErrorResponseDtoFactory.create(401, title, detail)),
    };
  },

  forbidden(title: string, detail?: string): HttpResponse {
    return {
      statusCode: 403,
      headers: defaultHeaders(),
      body: JSON.stringify(ErrorResponseDtoFactory.create(403, title, detail)),
    };
  },

  tooManyRequests(title: string, retryAfterSeconds: number, detail?: string): HttpResponse {
    return {
      statusCode: 429,
      headers: {
        ...defaultHeaders(),
        'Retry-After': String(retryAfterSeconds),
      },
      body: JSON.stringify(ErrorResponseDtoFactory.create(429, title, detail)),
    };
  },

  /**
   * RFC 7231 §6.5.5 — server MUST send `Allow` header listing supported
   * methods. Use this when a known resource was hit with the wrong
   * verb; `badRequest('Method not allowed')` is technically a category
   * error and trips strict API gateways.
   */
  methodNotAllowed(allow: string): HttpResponse {
    return {
      statusCode: 405,
      headers: { ...defaultHeaders(), Allow: allow },
      body: JSON.stringify(
        ErrorResponseDtoFactory.create(405, 'Method Not Allowed', `Allowed: ${allow}`),
      ),
    };
  },

  notFound(title: string, detail?: string): HttpResponse {
    return {
      statusCode: 404,
      headers: defaultHeaders(),
      body: JSON.stringify(ErrorResponseDtoFactory.create(404, title, detail)),
    };
  },

  conflict(title: string, detail?: string): HttpResponse {
    return {
      statusCode: 409,
      headers: defaultHeaders(),
      body: JSON.stringify(ErrorResponseDtoFactory.create(409, title, detail)),
    };
  },

  unprocessableEntity(
    title: string,
    invalidParams?: Array<{ name: string; reason: string }>,
    detail?: string,
  ): HttpResponse {
    const body = invalidParams
      ? ErrorResponseDtoFactory.createValidation(title, invalidParams, detail)
      : ErrorResponseDtoFactory.create(422, title, detail);

    return {
      statusCode: 422,
      headers: defaultHeaders(),
      body: JSON.stringify(body),
    };
  },

  fromZodError(error: ZodError): HttpResponse {
    return {
      statusCode: 422,
      headers: defaultHeaders(),
      body: JSON.stringify(ErrorResponseDtoFactory.fromZodError(error)),
    };
  },

  fromError(error: Error, statusCode = 500): HttpResponse {
    return {
      statusCode,
      headers: defaultHeaders(),
      body: JSON.stringify(ErrorResponseDtoFactory.fromError(error, statusCode)),
    };
  },

  internalServerError(title = 'Internal server error', detail?: string): HttpResponse {
    return {
      statusCode: 500,
      headers: defaultHeaders(),
      body: JSON.stringify(ErrorResponseDtoFactory.create(500, title, detail)),
    };
  },
};
