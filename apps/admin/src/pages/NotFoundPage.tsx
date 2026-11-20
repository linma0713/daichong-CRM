import { Link } from 'react-router';
import { Button, Result } from 'antd';

export function NotFoundPage() {
  return (
    <Result
      status="404"
      title="页面不存在"
      subTitle="地址可能写错了，或者这个功能还没上线。"
      extra={
        <Link to="/">
          <Button type="primary">回到工作台</Button>
        </Link>
      }
    />
  );
}
