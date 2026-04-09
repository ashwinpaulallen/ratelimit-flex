/**
 * Example `CreateTable` input shape for a DynamoDB rate-limit table.
 * The library does not call `CreateTable` at runtime — use this (or CDK / Terraform) yourself.
 */
export const dynamoStoreTableSchema = {
  TableName: 'rate_limits',
  KeySchema: [{ AttributeName: 'pk', KeyType: 'HASH' }],
  AttributeDefinitions: [{ AttributeName: 'pk', AttributeType: 'S' }],
  BillingMode: 'PAY_PER_REQUEST',
  // TTL is enabled via a separate UpdateTimeToLive call after creation:
  //   { Enabled: true, AttributeName: 'ttl' }
};

/**
 * Example `UpdateTimeToLive` input to enable TTL on the `ttl` attribute.
 * Run after the table exists.
 */
export const dynamoStoreEnableTtlParams = {
  TableName: 'rate_limits',
  TimeToLiveSpecification: {
    Enabled: true,
    AttributeName: 'ttl',
  },
};
