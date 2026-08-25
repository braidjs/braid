import express from 'express';
import { createGateway } from '@braidlabs/gateway';
import { toNodeMiddleware } from '@braidlabs/gateway/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = 3000;

// 1. Configure the Braid Gateway with the fragment manifest
const gateway = createGateway({
  registry: [
    {
      id: 'billing',
      endpoint: `http://localhost:${port}/billing-upstream`,
      pierce: ['/billing', '/billing/*'],
      timeoutMs: 2000,
      fallback: 'placeholder',
    },
  ],
});

// 2. Mount Braid Gateway origin middleware
app.use(toNodeMiddleware(gateway));

// 3. Upstream Billing Service Mock (Simulating separate remote endpoint)
app.use('/billing-upstream', express.static(path.join(__dirname, 'public/billing')));

// 4. Host Shell Service
app.use(express.static(path.join(__dirname, 'public/shell')));

// 5. Host SPA Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public/shell/index.html'));
});

app.listen(port, () => {
  console.log(`\n🚀 Acme Portal with Braid Gateway running at http://localhost:${port}`);
  console.log(`   - Composed App: http://localhost:${port}/billing`);
});
