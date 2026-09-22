import { Link } from 'react-router-dom';
import { useAuth } from '../auth/context';
import { AuthForm } from './AuthForm';

export function LoginPage() {
  const { signIn } = useAuth();
  // On success the auth state changes and <GuestOnly> sends the user to where they were headed.
  return (
    <AuthForm
      title="Log in"
      submitLabel="Log in"
      passwordAutoComplete="current-password"
      onSubmit={signIn}
      footer={
        <p>
          New here? <Link to="/signup">Create an account</Link>
        </p>
      }
    />
  );
}
