import { CtaButton, Eyebrow, FallbackLink, Heading, Layout, Paragraph } from './theme.js';

export default function TeamInvite({ inviteUrl, teamName, inviterEmail, role }: {
  inviteUrl: string; teamName: string; inviterEmail: string; role: string;
}) {
  return (
    <Layout preview={`You've been invited to join ${teamName} on devplat.`}>
      <Eyebrow>Team invitation</Eyebrow>
      <Heading>Join {teamName} on devplat.</Heading>
      <Paragraph>
        {inviterEmail} invited you to join the team <strong>{teamName}</strong> as{' '}
        <strong>{role}</strong>. devplat runs your Testcontainers workloads on Firecracker
        microVMs in Basel — your tests stay where they are, the containers move to us.
      </Paragraph>
      <CtaButton href={inviteUrl}>Accept invitation</CtaButton>
      <Paragraph>The invitation is valid for 7 days.</Paragraph>
      <FallbackLink href={inviteUrl} />
    </Layout>
  );
}
