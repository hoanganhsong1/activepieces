// Display-only rebrand helper: shows piece package names as
// @motomuraplatform/feature-* instead of @activepieces/piece-*.
//
// This only transforms what's rendered to the user. It must never be used
// for the actual value passed to APIs, piece resolution, connection auth,
// etc. — the real npm package name (e.g. "@activepieces/piece-slack") is
// still what's stored and sent to the backend; only the on-screen label
// changes here.
export const getDisplayPackageName = (packageName: string): string => {
  return packageName
    .replace('@activepieces/', '@motomura/')
    .replace('piece-', 'feature-');
};
