import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function VerifyEmailChange({ confirmUrl }: { confirmUrl: string }) {
  return (
    <Layout preview="Confirm your new devplat email address">
      <Eyebrow>Email change</Eyebrow>
      <Heading>Confirm your new address.</Heading>
      <Paragraph>
        Someone asked to move a devplat account to this address. Clicking below completes the
        change and makes this your new sign-in email.
      </Paragraph>
      <Paragraph>
        If that wasn&rsquo;t you, ignore this message — nothing changes until the link is used,
        and the existing address keeps working.
      </Paragraph>
      <CtaButton href={confirmUrl}>Confirm new address</CtaButton>
      <FallbackLink href={confirmUrl} />
    </Layout>
  );
}
