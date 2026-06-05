declare module '@lapo/asn1js/int10' {
  const Int10: unknown;
  export default Int10;
}

declare module '@lapo/asn1js/oids' {
  const oids: unknown;
  export default oids;
}

declare module 'ofd-tools' {
  export function parseOfdDocument(options: {
    ofd: File | ArrayBuffer | string;
    success?: (res: any[]) => void;
    fail?: (e: unknown) => void;
  }): void;

  export function renderOfd(screenWidth: number, ofd: any): HTMLDivElement[];
}
