/**
 * Where the hub can pull a camera's video from. The hub connects to it itself (only when someone
 * watches), so video never passes through the plugin process; credentials stay in hub memory.
 */
export interface CameraSource {
  /** rtsp:// or rtsps:// URL of the main (or a sub) stream, without credentials */
  url: string;
  username?: string;
  password?: string;
  /** Optional http(s) URL that returns a JPEG still (ONVIF GetSnapshotUri) */
  snapshotUrl?: string;
}
