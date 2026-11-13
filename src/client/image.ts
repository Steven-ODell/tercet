import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
import { fitImageAttachmentSize } from "@t3tools/client-runtime/image-attachment-size";

/** The clipboard read asks for PNG; reject malformed or oversized images before upload. */
export function validateClipboardPng(bytes: Uint8Array) {
  const data = Buffer.from(bytes);
  if (
    data.length < 33 ||
    !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    data.toString("ascii", 12, 16) !== "IHDR"
  )
    throw new Error("Clipboard does not contain a PNG.");
  const width = data.readUInt32BE(16),
    height = data.readUInt32BE(20);
  if (!width || !height) throw new Error("Invalid PNG dimensions.");
  if (data.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES || fitImageAttachmentSize({ width, height }))
    throw new Error("Resize image to at most 2000px per edge and 10 MB before attaching.");
}
export interface PendingImage {
  key: string;
  bytes: Uint8Array;
  /** Set for a picked file; a clipboard image has none and uploads as clipboard.png. */
  upload?: import("./connection").UploadMeta;
  uploaded?:
    | import("@t3tools/contracts").ChatImageAttachment
    | import("@t3tools/contracts").ChatFileAttachment;
}
