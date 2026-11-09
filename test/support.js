import { request as httpRequest } from 'node:http';
import { identityHeaders } from '../src/ui/identity.js';

// Passe par http.request : fetch interdit de choisir les en-têtes Host et Origin, or ce sont eux qu'on teste.
export function raw(origin, { method = 'GET', path: target = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(`${origin}${target}`, { method, headers }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text }));
    });
    request.on('error', reject);
    request.end(body);
  });
}

// Se comporte comme l'administration Django : chaque requête porte l'identité signée de la personne.
export function signedClient(origin, secret, { username, name = username, role }, { now = () => Date.now() } = {}) {
  return async (method, target, body, extraHeaders = {}) => {
    const url = `/api${target}`;
    const response = await raw(origin, {
      method,
      path: url,
      headers: {
        ...(secret ? identityHeaders(secret, { method, url, username, name, role, now: now() }) : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = {};
    try {
      json = JSON.parse(response.text || '{}');
    } catch {
      json = { text: response.text };
    }
    return { status: response.status, json, headers: response.headers };
  };
}
