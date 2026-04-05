import type { IdentityServices } from "../services";

export type IdentityUserDirectoryPort = Readonly<{
  getUser: IdentityServices["users"]["getUser"];
  getUserByEmail: IdentityServices["users"]["getUserByEmail"];
}>;

export function createIdentityUserDirectoryPort(
  services: IdentityServices,
): IdentityUserDirectoryPort {
  return {
    getUser: services.users.getUser,
    getUserByEmail: services.users.getUserByEmail,
  };
}
