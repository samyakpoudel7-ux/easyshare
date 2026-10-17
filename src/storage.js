import {
  S3Client, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const Bucket = process.env.S3_BUCKET;
const client = new S3Client({
  region: process.env.S3_REGION || 'auto',
  endpoint: process.env.S3_ENDPOINT || undefined,
  forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
  credentials: { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY },
  // keep presigned URLs browser-friendly (no checksum headers)
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
});

export const create = async (Key) =>
  (await client.send(new CreateMultipartUploadCommand({ Bucket, Key, ContentType: 'application/octet-stream' }))).UploadId;
export const partUrl = (Key, UploadId, PartNumber) =>
  getSignedUrl(client, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 3600 });
export const complete = (Key, UploadId, Parts) =>
  client.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts } }));
export const abort = (Key, UploadId) =>
  client.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId })).catch(() => {});
export const size = async (Key) => (await client.send(new HeadObjectCommand({ Bucket, Key }))).ContentLength;
export const getUrl = (Key) => getSignedUrl(client, new GetObjectCommand({ Bucket, Key }), { expiresIn: 3600 });
export async function remove(keys) {
  for (let i = 0; i < keys.length; i += 1000) {
    await client.send(new DeleteObjectsCommand({
      Bucket, Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
    }));
  }
}
