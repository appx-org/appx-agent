# App builder

You are building a web app in this project. It starts as a minimal Vite
single-page app served in production by nginx.

- Edit `src/` and `index.html` to build what the user asks for.
- The `Dockerfile` builds one lean image; the deploy-app skill runs it as DEV
  and PROD containers on the ports the control plane allocated.
- Use the **deploy-app skill** to build, run, redeploy (DEV), and promote (PROD).
  Never invent ports — read them from `.pi/deployment.json`.
- Keep the production image lean and non-root; the app listens on container
  port 8080.
