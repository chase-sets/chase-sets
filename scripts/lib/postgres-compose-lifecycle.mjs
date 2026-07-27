const postgresCheckpointCommand = 'exec psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --command CHECKPOINT';

export async function stopComposePostgresCleanly({ invocation, env, run, observe = () => undefined }) {
  let checkpointed = false;

  observe("Flushing the sandbox PostgreSQL shutdown checkpoint...");
  try {
    await run(
      invocation.command,
      [...invocation.args, "exec", "-T", "postgres", "sh", "-ceu", postgresCheckpointCommand],
      {
        env,
        prefix: "postgres",
      },
    );
    checkpointed = true;
    observe("Sandbox PostgreSQL shutdown checkpoint completed.");
  } catch (error) {
    observe(
      `Sandbox PostgreSQL was unavailable for a shutdown checkpoint; continuing with Compose teardown: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  await run(invocation.command, [...invocation.args, "down"], {
    env,
    prefix: "docker",
  });

  return { checkpointed };
}
