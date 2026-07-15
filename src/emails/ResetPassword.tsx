import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function ResetPassword({ resetUrl }: { resetUrl: string }) {
  return (
    <Layout preview="Reset your devplat password.">
      <Eyebrow>Password reset</Eyebrow>
      <Heading>Set a new password.</Heading>
      <Paragraph>
        Someone (hopefully you) requested a password reset for your devplat account.
        The link below is valid for 24 hours and can be used once.
      </Paragraph>
      <CtaButton href={resetUrl}>Choose a new password</CtaButton>
      <Paragraph>
        If you didn't request this, ignore this email — your password stays unchanged.
      </Paragraph>
      <FallbackLink href={resetUrl} />
    </Layout>
  );
}
