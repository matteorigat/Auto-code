import { Router, Request, Response, NextFunction } from 'express';
import type { AppConfig } from '../../config/index.js';

interface RouterDeps {
  config: AppConfig;
}

export function createOmniRouteProxyRouter({ config }: RouterDeps) {
  const router = Router();

  const OMNIROUTE_BASE = config.omniroute.url;
  const API_KEY = config.omniroute.apiKey;

  if (!API_KEY) {
    console.warn('[omniroute-proxy] No API key configured — proxy will return 503');
  }

  router.all('/*', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const targetPath = `/api${req.path}`;
      const queryString = new URLSearchParams(
        req.query as Record<string, string>,
      ).toString();
      const targetUrl = `${OMNIROUTE_BASE}${targetPath}${queryString ? '?' + queryString : ''}`;

      const method = req.method.toUpperCase();

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (API_KEY) {
        headers['Authorization'] = `Bearer ${API_KEY}`;
      }

      const body =
        ['POST', 'PUT', 'PATCH'].includes(method) && req.body
          ? JSON.stringify(req.body)
          : undefined;

      const response = await fetch(targetUrl, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(15000),
      });

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const data = await response.json();
        res.status(response.status).json(data);
      } else {
        const text = await response.text();
        res.status(response.status).type('text/plain').send(text);
      }
    } catch (err) {
      const error = err as Error;
      if (error.name === 'AbortError' || error.message?.includes('timeout')) {
        res.status(504).json({ error: 'OmniRoute proxy timeout' });
      } else if (error.message?.includes('ECONNREFUSED')) {
        res.status(502).json({ error: 'OmniRoute is not running' });
      } else {
        next(error);
      }
    }
  });

  return router;
}
