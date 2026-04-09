import { BatchWriteCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/** See module doc in `DynamoStore.test.ts` — env flags for when this backend runs. */

/** Remove all items (same `pk` key schema as {@link dynamoStoreTableSchema}). */
export async function clearDynamoRateLimitsTable(
  doc: DynamoDBDocumentClient,
  tableName: string,
): Promise<void> {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  for (;;) {
    const out = await doc.send(
      new ScanCommand({
        TableName: tableName,
        ProjectionExpression: 'pk',
        ExclusiveStartKey,
      }),
    );
    const items = out.Items ?? [];
    for (let i = 0; i < items.length; i += 25) {
      const chunk = items.slice(i, i + 25);
      if (chunk.length === 0) {
        break;
      }
      await doc.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: chunk.map((it) => ({
              DeleteRequest: { Key: { pk: it['pk'] as string } },
            })),
          },
        }),
      );
    }
    ExclusiveStartKey = out.LastEvaluatedKey;
    if (!ExclusiveStartKey) {
      break;
    }
  }
}

export const runDynamoStoreIntegration =
  process.env.DYNAMO_STORE_TEST !== '0' &&
  (Boolean(process.env.DYNAMO_TEST_ENDPOINT) ||
    process.env.DYNAMO_STORE_TEST === '1' ||
    process.env.CI === 'true');

export async function initDynamoStoreTestBackend(): Promise<{
  endpoint: string;
  cleanup: () => Promise<void>;
}> {
  const explicit = process.env.DYNAMO_TEST_ENDPOINT;
  if (explicit) {
    return { endpoint: explicit.replace(/\/$/, ''), cleanup: async () => {} };
  }

  const { GenericContainer } = await import('testcontainers');
  const container = await new GenericContainer('amazon/dynamodb-local:2.5.2')
    .withExposedPorts(8000)
    .start();

  const host = container.getHost();
  const port = container.getMappedPort(8000);
  const endpoint = `http://${host}:${port}`;

  return {
    endpoint,
    cleanup: async () => {
      await container.stop();
    },
  };
}
