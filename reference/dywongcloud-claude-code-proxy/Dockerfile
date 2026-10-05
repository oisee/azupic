FROM node:22-alpine

LABEL org.opencontainers.image.title="claude-code-proxy-openai-moonshot" \
      org.opencontainers.image.description="Anthropic-compatible Claude Code proxy for OpenAI and Moonshot API keys" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app
COPY --chown=node:node package.json LICENSE README.md ./
COPY --chown=node:node bin ./bin
COPY --chown=node:node src ./src

RUN mkdir -p /home/node/.config/claude-code-proxy /home/node/.local/state/claude-code-proxy \
    && chown -R node:node /home/node/.config /home/node/.local

USER node
ENV NODE_ENV=production \
    CCP_BIND_ADDRESS=0.0.0.0 \
    PORT=18765 \
    CCP_CONFIG_DIR=/home/node/.config/claude-code-proxy \
    CCP_STATE_DIR=/home/node/.local/state/claude-code-proxy

EXPOSE 18765
VOLUME ["/home/node/.config/claude-code-proxy", "/home/node/.local/state/claude-code-proxy"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:18765/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "/app/bin/claude-code-proxy.js"]
CMD ["serve"]

