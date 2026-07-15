import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function VerifyEmail({ verifyUrl }: { verifyUrl: string }) {
  return (
    <Layout preview="Confirm your email address to activate your devplat account.">
      <Eyebrow>Email verification</Eyebrow>
      <Heading>One click, and your account is live.</Heading>
      <Paragraph>
        Thanks for signing up for devplat — the remote backend for Testcontainers, hosted in
        Zurich. Confirm your email address to activate your account. The link is valid for 24 hours.
      </Paragraph>
      <CtaButton href={verifyUrl}>Confirm email address</CtaButton>
      <Paragraph>
        If you didn't create this account, you can safely ignore this email — nothing will be activated.
      </Paragraph>
      <FallbackLink href={verifyUrl} />
    </Layout>
  );
}
