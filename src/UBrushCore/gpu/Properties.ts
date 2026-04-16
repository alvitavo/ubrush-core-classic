export class Properties {

    private properties = new WeakMap();

    // constructor() {

    // }

    get(object: any): any {

        let map = this.properties.get(object);

        if (map === undefined) {

            map = {};
            this.properties.set(object, map);

        }

        return map;

    }

    remove(object: any): void {

        this.properties.delete(object);

    }

    update(object: any, key: any, value: any): any {

        this.properties.get(object)[key] = value;

    }

    dispose(): void {

        this.properties = new WeakMap();

    }

}