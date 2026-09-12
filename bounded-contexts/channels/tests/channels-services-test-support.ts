import { module as channelsModule } from "../index";

// Route tests replace the feature services they exercise. Unused services retain
// the real composition shape, with database access failing on unexpected calls.
export function createChannelsServicesForTest() {
  const unavailable = async (): Promise<never> => {
    throw new Error("Unexpected database access in a Channels route unit test");
  };
  return channelsModule.createServices({ query: unavailable, connect: unavailable }, {});
}
