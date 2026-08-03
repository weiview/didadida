export const onRequest = async (context: any) => {
  const country = context.request.headers.get('cf-ipcountry');
  
  if (country && country !== 'TW' && country !== 'XX' && country !== 'T1') {
    return new Response('Access Denied. Only accessible from Taiwan.', { status: 403 });
  }

  return context.next();
};
