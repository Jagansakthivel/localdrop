/** Attachments remain authoritative; cache socket identities only, never cached metadata. */
export interface RoomMember {id:string;roomCode:string}
export class RoomIndex<S extends object,M extends RoomMember>{
  private rooms=new Map<string,Set<S>>();
  private membership=new WeakMap<S,string>();
  constructor(private readonly read:(socket:S)=>M|null,private readonly open:(socket:S)=>boolean){}
  hydrate(sockets:Iterable<S>){for(const s of sockets){try{const m=this.read(s);if(m&&this.open(s))this.update(s,m.roomCode);}catch{/* invalid attachment */}}}
  update(socket:S,room:string){const old=this.membership.get(socket);if(old===room)return;this.remove(socket);if(!room)return;let set=this.rooms.get(room);if(!set){set=new Set();this.rooms.set(room,set);}set.add(socket);this.membership.set(socket,room);}
  remove(socket:S){const old=this.membership.get(socket);if(old!==undefined){const set=this.rooms.get(old);set?.delete(socket);if(!set?.size)this.rooms.delete(old);this.membership.delete(socket);}}
  members(room:string):{ws:S;meta:M}[]{if(!room)return [];const out:{ws:S;meta:M}[]=[];for(const s of this.rooms.get(room)??[]){try{const m=this.read(s);if(!this.open(s)||!m||m.roomCode!==room){this.remove(s);continue;}out.push({ws:s,meta:m});}catch{this.remove(s);}}return out;}
}
