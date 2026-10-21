import type { Readable } from "node:stream";
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, PutObjectCommand, S3Client
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

// Private S3-compatible storage (MinIO locally). The bucket is never public: browsers only ever get
// short-lived presigned URLs, and downloads are only presigned after a file has been scanned clean.
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
const UPLOAD_URL_TTL_SECONDS = 5 * 60;
const DOWNLOAD_URL_TTL_SECONDS = 60;
// Only these are rendered inline; everything else (including SVG and HTML) is forced to download.
export const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const bucket = process.env.S3_BUCKET || "orbit-chat-attachments";

function makeClient(endpoint: string | undefined) {
  return new S3Client({
    region: process.env.S3_REGION || "us-east-1",
    endpoint,
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE !== "false",
    // Otherwise the SDK bakes a checksum of the (empty) request body into presigned PUT URLs, so the
    // browser's upload of the real file fails signature/checksum validation.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    credentials: process.env.S3_ACCESS_KEY_ID
      ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || "" }
      : undefined
  });
}

const globalForStorage = globalThis as unknown as { s3?: S3Client; s3Public?: S3Client };
const s3 = globalForStorage.s3 ?? makeClient(process.env.S3_ENDPOINT);
// Presigned URLs must use a hostname the browser can reach, which may differ from the server's endpoint.
const s3Public = globalForStorage.s3Public ?? makeClient(process.env.S3_PUBLIC_ENDPOINT || process.env.S3_ENDPOINT);
globalForStorage.s3 = s3;
globalForStorage.s3Public = s3Public;

export function storageConfigured() {
  return Boolean(process.env.S3_ENDPOINT || process.env.S3_BUCKET);
}

export async function ensureBucket() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
}

export function presignUpload(key: string, contentType: string) {
  return getSignedUrl(s3Public, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: UPLOAD_URL_TTL_SECONDS });
}

export function presignDownload(key: string, fileName: string, contentType: string) {
  const disposition = INLINE_IMAGE_TYPES.has(contentType) ? "inline" : "attachment";
  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentType: INLINE_IMAGE_TYPES.has(contentType) ? contentType : "application/octet-stream",
    ResponseContentDisposition: `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`
  });
  return getSignedUrl(s3Public, command, { expiresIn: DOWNLOAD_URL_TTL_SECONDS });
}

export async function objectSize(key: string) {
  try {
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return head.ContentLength ?? null;
  } catch {
    return null;
  }
}

export async function openObject(key: string) {
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return object.Body as Readable;
}

export async function deleteObject(key: string) {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}
