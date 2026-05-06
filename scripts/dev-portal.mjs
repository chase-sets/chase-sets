import { createServer } from "node:http";

const port = parseInt(process.env.PORT ?? "6170", 10);

const services = [
  {
    name: "Admin Web",
    url: "http://localhost:6172",
    description: "Unified catalog and identity administration workspace",
    category: "frontend",
  },
  {
    name: "Marketplace",
    url: "http://localhost:6173",
    description: "Buyer and seller marketplace experience",
    category: "frontend",
  },
  {
    name: "Platform API",
    url: "http://localhost:6182",
    description: "Unified API host composed from the active bounded contexts",
    category: "api",
  },
];

function renderPage() {
  const frontends = services.filter((service) => service.category === "frontend");
  const apis = services.filter((service) => service.category === "api");

  const renderCard = (service) => `
    <a href="${service.url}" target="_blank" class="card">
      <div class="card-header">
        <span class="card-name">${service.name}</span>
        <span class="badge badge-${service.category}">${service.category}</span>
      </div>
      <p class="card-description">${service.description}</p>
      <span class="card-url">${service.url}</span>
    </a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Chase Sets - Dev Portal</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #0a0a0b;
      --surface: #141416;
      --surface-hover: #1c1c20;
      --border: #27272a;
      --text: #fafafa;
      --text-muted: #a1a1aa;
      --accent: #3b82f6;
      --accent-dim: rgba(59, 130, 246, 0.12);
      --green: #22c55e;
      --green-dim: rgba(34, 197, 94, 0.12);
      --purple: #a855f7;
      --purple-dim: rgba(168, 85, 247, 0.12);
      --radius: 10px;
    }

    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 3rem 1.5rem;
    }

    .container {
      max-width: 800px;
      margin: 0 auto;
    }

    header {
      margin-bottom: 3rem;
    }

    h1 {
      font-size: 1.75rem;
      font-weight: 600;
      letter-spacing: -0.025em;
      margin-bottom: 0.25rem;
    }

    .subtitle {
      color: var(--text-muted);
      font-size: 0.9375rem;
    }

    .section { margin-bottom: 2.5rem; }

    .section-title {
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      margin-bottom: 0.75rem;
      padding-left: 0.125rem;
    }

    .grid {
      display: grid;
      gap: 0.75rem;
    }

    .card {
      display: block;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem 1.25rem;
      text-decoration: none;
      color: inherit;
      transition: background 150ms, border-color 150ms;
    }

    .card:hover {
      background: var(--surface-hover);
      border-color: var(--accent);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 0.375rem;
    }

    .card-name {
      font-weight: 600;
      font-size: 0.9375rem;
    }

    .badge {
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      padding: 0.175rem 0.5rem;
      border-radius: 9999px;
    }

    .badge-frontend {
      background: var(--purple-dim);
      color: var(--purple);
    }

    .badge-api {
      background: var(--green-dim);
      color: var(--green);
    }

    .card-description {
      font-size: 0.8125rem;
      color: var(--text-muted);
      line-height: 1.5;
      margin-bottom: 0.5rem;
    }

    .card-url {
      font-size: 0.75rem;
      font-family: "SF Mono", "Fira Code", "Fira Mono", Menlo, monospace;
      color: var(--accent);
    }

    footer {
      margin-top: 3rem;
      padding-top: 1.5rem;
      border-top: 1px solid var(--border);
      color: var(--text-muted);
      font-size: 0.8125rem;
    }

    footer kbd {
      display: inline-block;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 4px;
      padding: 0.1rem 0.4rem;
      font-family: inherit;
      font-size: 0.75rem;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>Chase Sets</h1>
      <p class="subtitle">Local development services</p>
    </header>

    <section class="section">
      <h2 class="section-title">Web Deployables</h2>
      <div class="grid">
        ${frontends.map(renderCard).join("")}
      </div>
    </section>

    <section class="section">
      <h2 class="section-title">API Deployables</h2>
      <div class="grid">
        ${apis.map(renderCard).join("")}
      </div>
    </section>

    <footer>
      Start the full stack with <kbd>npm run dev</kbd> - stop with <kbd>Ctrl+C</kbd>
    </footer>
  </div>
</body>
</html>`;
}

const server = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage());
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Dev portal port ${port} is already in use. Kill the existing process and retry.`);
    process.exit(1);
  }

  throw error;
});

server.listen(port, () => {
  console.log(`Dev portal: http://localhost:${port}`);
});
