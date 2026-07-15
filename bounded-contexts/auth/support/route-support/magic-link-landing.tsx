import type { LoaderFunctionArgs } from "react-router";
import { Banner, Container, Heading, LinkButton, Stack, Text } from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import { AuthApiError } from "../../client";
import type { AuthHost, InteractiveAuthResult } from "./auth-host";
import { createAuthRequestApiClient } from "./auth-host";

export type MagicLinkLandingLoaderData = Readonly<{
  title: string;
  description: string;
  signInHref: string;
}>;

function signInHref(signInPath: string, returnTo: string) {
  const url = new URL(signInPath, "https://chase-sets.local");
  url.searchParams.set("returnTo", returnTo);
  return `${url.pathname}${url.search}`;
}

function errorData(
  request: Request,
  options: Readonly<{
    authHost: AuthHost;
    signInPath: string;
    title: string;
    description: string;
  }>,
): MagicLinkLandingLoaderData {
  return {
    title: options.title,
    description: options.description,
    signInHref: signInHref(options.signInPath, options.authHost.getReturnTo(request)),
  };
}

export function createMagicLinkLandingLoader(
  options: Readonly<{
    authHost: AuthHost;
    signInPath: string;
  }>,
) {
  return async ({ request }: LoaderFunctionArgs): Promise<Response | MagicLinkLandingLoaderData> => {
    const url = new URL(request.url);
    const token = url.searchParams.get("token")?.trim();
    if (!token) {
      return errorData(request, {
        ...options,
        title: t("auth.support.routeSupport.magicLinkLanding.magic.link.could.not.be.completed"),
        description: t("auth.support.routeSupport.magicLinkLanding.magic.link.is.missing"),
      });
    }

    try {
      const api = createAuthRequestApiClient(request);
      const result = await api.consumeMagicLink<InteractiveAuthResult>({ token });
      return options.authHost.completeAuthentication(request, result);
    } catch (error) {
      if (error instanceof AuthApiError && error.status === 401) {
        return errorData(request, {
          ...options,
          title: t("auth.support.routeSupport.magicLinkLanding.magic.link.expired.or.used"),
          description: t("auth.support.routeSupport.magicLinkLanding.request.a.new.sign.in.link"),
        });
      }

      if (error instanceof AuthApiError) {
        return errorData(request, {
          ...options,
          title: t("auth.support.routeSupport.magicLinkLanding.sign.in.temporarily.unavailable"),
          description: error.message,
        });
      }

      throw error;
    }
  };
}

export function MagicLinkLandingPage(props: Readonly<{ data: MagicLinkLandingLoaderData }>) {
  return (
    <Container width="narrow" paddingX={0}>
      <Stack gap={4}>
        <Stack gap={2}>
          <Heading level={1} visualSize={5}>
            {props.data.title}
          </Heading>
          <Text tone="secondary">{props.data.description}</Text>
        </Stack>
        <Banner title={props.data.title} description={props.data.description} tone="danger" role="alert" />
        <LinkButton href={props.data.signInHref} leadingIcon="message">
          {t("auth.support.routeSupport.magicLinkLanding.request.new.link")}
        </LinkButton>
      </Stack>
    </Container>
  );
}
