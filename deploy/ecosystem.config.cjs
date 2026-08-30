const deployRoot = process.env.NAISKOS_DEPLOY_ROOT ?? "/opt/naiskos-server";
const current = `${deployRoot}/current`;
const node = process.env.NAISKOS_NODE_BIN ?? process.execPath;
const serverEnv = `${deployRoot}/shared/secrets/server.env`;
const storageRoot =
  process.env.NAISKOS_STORAGE_ROOT ?? `${deployRoot}/shared/storage`;

module.exports = {
  apps: [
    {
      name: "naiskos-api",
      script: "dist/api-main.js",
      cwd: current,
      interpreter: node,
      node_args: [`--env-file=${serverEnv}`],
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "300M",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "naiskos-worker",
      script: "dist/worker-main.js",
      cwd: current,
      interpreter: node,
      node_args: [`--env-file=${serverEnv}`],
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "900M",
      kill_timeout: 240000,
      env: {
        NODE_ENV: "production",
        MALLOC_ARENA_MAX: "2",
      },
    },
    {
      name: "naiskos-telegram-bot-api",
      script: "deploy/run-telegram-bot-api",
      cwd: current,
      interpreter: "/bin/bash",
      instances: 1,
      exec_mode: "fork",
      autorestart: true,
      max_memory_restart: "500M",
      env: {
        NAISKOS_DEPLOY_ROOT: deployRoot,
        NAISKOS_TELEGRAM_DATA_DIR: `${storageRoot}/telegram/data`,
        NAISKOS_TELEGRAM_TEMP_DIR: `${storageRoot}/temp/telegram-bot-api`,
      },
    },
  ],
};
