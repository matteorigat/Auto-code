import { Router } from 'express';
import express from 'express';
import { join } from 'node:path';

export function createStaticRouter() {
  const router = Router();
  const DASHBOARD_DIR = join(process.cwd(), 'dashboard');

  router.get('/', (req, res) => {
    res.sendFile(join(DASHBOARD_DIR, 'index.html'));
  });

  // Serve CSS and JS files
  router.use('/css', express.static(join(DASHBOARD_DIR, 'css')));
  router.use('/js', express.static(join(DASHBOARD_DIR, 'js')));

  return router;
}
