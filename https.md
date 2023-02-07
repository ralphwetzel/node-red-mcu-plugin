# HTTPS support for your local server running Node-RED

To use some of the advanced features of this plugin, the server running Node-RED needs to support the `https` protocol, even as it's located in your local network only. Usually you yet don't want to invest in a commercial certificate, just to get these credentials for your little Pi. As it shows up, this as well isn't necessary at all:

The following procedure illustrates a way to create first your own locally trusted Certification Authority to then issue the right credentials for your local Node-RED server.

We anticipate, that you're working currently with your development system (devSys), that might be a Laptop, MacBook, Desktop computer or whatever. Somewhere in your local network, there's the system, e.g. a Pi, running your Node-RED server; for the sake of simplicity, we'll call this system from now on "your Pi", even if it was something else.

Please be aware that you have to have `root` / `admin` privileges on both systems to finish this procedure successfully!

Let's begin!

## Create your own local CA (Certifcation Authority)
Download and install [`mkcert`](https://github.com/FiloSottile/mkcert) on your devSys.

Run `mkcert -install` to create and install the CA. This will popup (in case several times) a dialog window to confirm the change by entering an `admin` password.

## Check your trust store
You should check your trust store (on Mac this is called Keychain) then to verify that our local CA certificate was installed successful. Finding the certificate in the trust store (most probably under `Certificates`) gives you as well a hint relevant for later: The domain name your devSys considers itself being part of. In case your local network is controlled by a FritzBox, this most probably is "fritz.box"; another options may be e.g. "local". Write this down, you'll need it.

## Identify the hostname of your Pi
As a prerequisite to generate the correct certificate, you need to know the hostname of your Pi. Access it, then run

``` bash
hostname
```

in a Terminal. Keep in mind, that each of your devices should have a different hostname. In case, you may change it now...

## Generate the credentials for your Pi
On your sysDev, run
``` bash
mkcert -client <hostename>.<domainname>
```

Use the hostname you identified in the step before as `<hostname>`, the domain name from the trust store as `<domainname>`.

`mkcert` will now create two files:

```
<hostname>.<domainname>-client.pem
<hostname>.<domainname>-client-key.pem
```

and tell you, where those have been saved in your directory tree.

## Install the credentials for the Node-RED server on your Pi

Copy the two files generated in the step before to your Pi.
That done, follow the description given in the Node-RED documentation to [secure Node-RED](https://nodered.org/docs/user-guide/runtime/securing-node-red).

The `...-key.pem` file holds the required `key`, the other one the `cert`.

I propose you use absolute path definitions when including the file data into `settings.js`. That could save you some trouble...

## Restart your Node-RED server
Run 

```
node-red-stop
node-red-start
```

to restart the Node-RED server.

## Access Node-RED via https

On your devSys, open a browser window & enter

```
https://<hostname>.<domainname>:1880
```

That should open Node-RED, indicating a nice looking lock symbol in the address bar - indicating a trusted & secure connection.

Job done!