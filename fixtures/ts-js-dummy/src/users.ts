export interface User {
  id: string;
  name: string;
  email: string;
}

const USERS: User[] = [
  { id: "u-1", name: "Ada Lovelace", email: "ada@example.com" },
  { id: "u-2", name: "Alan Turing", email: "alan@example.com" },
];

export function findUser(id: string): User | undefined {
  return USERS.find((u) => u.id === id);
}

export function getUser(id: string): User {
  const user = findUser(id);
  if (!user) {
    throw new Error(`unknown user: ${id}`);
  }
  return user;
}
