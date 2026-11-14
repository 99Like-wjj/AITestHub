import { useState } from 'react';
import { Alert, Button, Form, Input, Space } from 'antd';
import { api, describeError } from './api';

type AuthMode = 'login' | 'register' | 'help' | 'reset';

interface AuthValues {
  account: string;
  displayName: string;
  password: string;
  confirmPassword: string;
  resetCode: string;
}

export const accountRules = [
  { required: true, message: '请输入账号' },
  {
    pattern: /^[A-Za-z0-9._-]{3,64}$/,
    message: '账号为 3–64 位字母、数字、点、下划线或短横线',
  },
];

export const passwordRules = [
  { required: true, message: '请输入密码' },
  { min: 15, max: 128, message: '密码须为 15–128 个字符，支持密码短语' },
];

export function AuthPage({
  onLogin,
  initialMessage,
}: {
  onLogin: () => Promise<void>;
  initialMessage?: string;
}) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState(initialMessage);
  const [form] = Form.useForm<AuthValues>();

  function changeMode(next: AuthMode) {
    form.resetFields(['password', 'confirmPassword', 'resetCode']);
    setError(undefined);
    setNotice(undefined);
    setMode(next);
  }

  async function submit(values: AuthValues) {
    setPending(true);
    setError(undefined);
    try {
      if (mode === 'login') {
        await api('/auth/login', {
          method: 'POST',
          body: { account: values.account, password: values.password },
        });
        await onLogin();
      } else if (mode === 'register') {
        await api('/auth/register', {
          method: 'POST',
          body: {
            account: values.account,
            displayName: values.displayName,
            password: values.password,
          },
        });
        form.resetFields(['password', 'confirmPassword', 'displayName']);
        setNotice('注册成功，请使用新账号登录。注册不会自动获得项目权限。');
        setMode('login');
      } else if (mode === 'reset') {
        await api('/auth/reset-password', {
          method: 'POST',
          body: { resetCode: values.resetCode, newPassword: values.password },
        });
        form.resetFields(['password', 'confirmPassword', 'resetCode']);
        setNotice('密码已设置，请重新登录。');
        setMode('login');
      }
    } catch (err) {
      setError(describeError(err));
    } finally {
      setPending(false);
    }
  }

  const title = {
    login: '欢迎回来',
    register: '创建账号',
    help: '管理员协助重置',
    reset: '设置新密码',
  }[mode];
  return (
    <main className="auth-page">
      <section className="auth-visual" aria-label="AITestHub">
        <img src="/brand-f-horizontal.png" alt="AITestHub" />
        <div>
          <h1>
            让每个判断
            <br />
            都能回到依据。
          </h1>
          <p>
            AI 设计与探索，人工确认与协作。
            <br />
            把需求、验证和交付连接在一起。
          </p>
        </div>
        <span className="small" style={{ color: '#9fbcb0' }}>
          Quality, connected.
        </span>
      </section>
      <section className="auth-form-wrap">
        <div className="auth-form">
          <h1>{title}</h1>
          <p className="caption">
            {mode === 'register'
              ? '注册后可进行个人聊天，项目权限由管理员添加。'
              : mode === 'login'
                ? '登录 AITestHub，继续你的测试协作。'
                : '使用一次性重置凭据设置新密码。'}
          </p>
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            {error && <Alert type="error" showIcon title={error} />}
            {notice && <Alert type="success" showIcon title={notice} />}
            {mode === 'help' ? (
              <>
                <Alert
                  type="info"
                  showIcon
                  title="请联系平台管理员核验身份并申请一次性重置凭据。管理员不能读取原密码。"
                />
                <Button
                  block
                  type="primary"
                  onClick={() => changeMode('reset')}
                >
                  已有重置凭据，设置新密码
                </Button>
                <Button block onClick={() => changeMode('login')}>
                  返回登录
                </Button>
              </>
            ) : (
              <Form
                form={form}
                layout="vertical"
                onFinish={(values: AuthValues) => void submit(values)}
                requiredMark={false}
              >
                {mode !== 'reset' && (
                  <Form.Item name="account" label="账号" rules={accountRules}>
                    <Input
                      autoComplete="username"
                      maxLength={64}
                      autoFocus
                      disabled={pending}
                    />
                  </Form.Item>
                )}
                {mode === 'register' && (
                  <Form.Item
                    name="displayName"
                    label="姓名"
                    rules={[
                      {
                        required: true,
                        whitespace: true,
                        max: 50,
                        message: '请输入 1–50 个字符的姓名',
                      },
                    ]}
                  >
                    <Input
                      autoComplete="name"
                      maxLength={50}
                      disabled={pending}
                    />
                  </Form.Item>
                )}
                {mode === 'reset' && (
                  <Form.Item
                    name="resetCode"
                    label="一次性重置凭据"
                    rules={[
                      {
                        required: true,
                        message: '请输入管理员提供的一次性重置凭据',
                      },
                    ]}
                  >
                    <Input.Password autoComplete="off" disabled={pending} />
                  </Form.Item>
                )}
                <Form.Item
                  name="password"
                  label={mode === 'reset' ? '新密码' : '密码'}
                  rules={
                    mode === 'login'
                      ? [{ required: true, message: '请输入密码' }]
                      : passwordRules
                  }
                >
                  <Input.Password
                    autoComplete={
                      mode === 'login' ? 'current-password' : 'new-password'
                    }
                    maxLength={128}
                    disabled={pending}
                  />
                </Form.Item>
                {mode !== 'login' && (
                  <Form.Item
                    name="confirmPassword"
                    label="确认密码"
                    dependencies={['password']}
                    rules={[
                      { required: true, message: '请再次输入密码' },
                      ({ getFieldValue }) => ({
                        validator(_, value: unknown) {
                          return value === getFieldValue('password')
                            ? Promise.resolve()
                            : Promise.reject(new Error('两次密码不一致'));
                        },
                      }),
                    ]}
                  >
                    <Input.Password
                      autoComplete="new-password"
                      maxLength={128}
                      disabled={pending}
                    />
                  </Form.Item>
                )}
                {mode === 'login' && (
                  <div className="row between">
                    <span />
                    <Button
                      type="link"
                      disabled={pending}
                      onClick={() => changeMode('help')}
                    >
                      忘记密码？
                    </Button>
                  </div>
                )}
                <Button
                  block
                  type="primary"
                  htmlType="submit"
                  loading={pending}
                >
                  {mode === 'login'
                    ? '登录'
                    : mode === 'register'
                      ? '注册'
                      : '设置新密码'}
                </Button>
                <div className="auth-footer">
                  {mode === 'login'
                    ? '还没有账号？'
                    : mode === 'register'
                      ? '已有账号？'
                      : ''}
                  <Button
                    type="link"
                    disabled={pending}
                    onClick={() =>
                      changeMode(mode === 'login' ? 'register' : 'login')
                    }
                  >
                    {mode === 'login' ? '注册账号' : '返回登录'}
                  </Button>
                </div>
              </Form>
            )}
          </Space>
        </div>
      </section>
    </main>
  );
}
