import { Eyebrow, Heading, Layout, Paragraph } from './theme.js';

export default function ContactSubmission({ name, email, company, message }: {
  name: string; email: string; company?: string; message: string;
}) {
  return (
    <Layout preview={`New contact form submission from ${name}`}>
      <Eyebrow>Contact form</Eyebrow>
      <Heading>New message from {name}.</Heading>
      <Paragraph>
        <strong>Email:</strong> {email}
        {company && <><br /><strong>Company:</strong> {company}</>}
      </Paragraph>
      <Paragraph>{message}</Paragraph>
    </Layout>
  );
}
