/** admin-web serves Reported Content in its Support section (context.json's route section). */
export const reportedContentQueuePath = "/support/reported-content";

/** A reported target's page in admin-web. */
export function reportedContentTargetPath(targetType: string, targetId: string) {
  return `${reportedContentQueuePath}/${encodeURIComponent(targetType)}/${encodeURIComponent(targetId)}`;
}
