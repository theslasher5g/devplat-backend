import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

/**
 * Sent to every member without a second factor at the moment an owner turns on
 * the team-wide requirement.
 *
 * Without it the first sign is a dashboard that stops working mid-task, with
 * no warning and no idea who changed what. The tone is deliberately "here is
 * what to do", not "you have been locked out": nothing is lost, and enrolling
 * takes a minute.
 */
export default function TwoFactorRequired({ teamName, ownerEmail, profileUrl }: {
  teamName: string; ownerEmail: string; profileUrl: string;
}) {
  return (
    <Layout preview={`${teamName} now requires two-factor authentication`}>
      <Eyebrow>Security</Eyebrow>
      <Heading>{teamName} now requires two-factor authentication.</Heading>
      <Paragraph>
        <strong>{ownerEmail}</strong> turned this on for the whole team. Your account doesn&rsquo;t have
        a second factor yet, so devplat will ask you to set one up the next time you open the
        dashboard.
      </Paragraph>
      <Paragraph>
        You can do it now instead and skip the interruption. It takes about a minute: scan a QR code
        with any authenticator app — Google Authenticator, 1Password, Bitwarden, Aegis — and enter
        the six-digit code it shows.
      </Paragraph>
      <Paragraph>
        Nothing has been deleted and no work is lost. Your environments, tokens and settings are all
        still there; you just need the second factor to reach them.
      </Paragraph>
      <CtaButton href={profileUrl}>Set up two-factor</CtaButton>
      <FallbackLink href={profileUrl} />
      <Paragraph>
        You&rsquo;ll also get ten single-use recovery codes. Save them somewhere other than the phone
        running your authenticator — they&rsquo;re the way back in if you lose the device, and we
        can&rsquo;t regenerate them for you.
      </Paragraph>
    </Layout>
  );
}
