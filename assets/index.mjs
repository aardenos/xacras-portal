


// import :: aarden : client
// ----------------------------------------------------------------------------------------------------------------------------
    import "/script.driver.mjs";
// ============================================================================================================================






// action :: aspect : info
// ----------------------------------------------------------------------------------------------------------------------------
    Global.Viewer = Plexus( function Viewer (){} )
    .recent
    ({
        chosen: 0,

        preset:
        [
            "./assets/theme-song.m4a",
        ],
    })
    .extend
    ({
        action:
        {
            butn ( select, vivify=true )
            {
                let button;


                Select( "*#iconPlay,#iconBusy,#iconPaus" ).map(( object )=>
                {
                    if ( !select )
                    {
                        if ( !(object.style.opacity*1) )
                        { return };

                        select = object.id;
                    };


                    object.style.opacity = 0;

                    if ( object.id !== select )
                    { return };

                    button = object;
                });



                if ( vivify )
                { button.style.opacity = 1 };

                return button;
            },


            play ()
            {
                let exists = Select( "#activeAudio" );
                let memory = Viewer.recent("*");


                if ( !!exists )
                {
                    exists.active = !exists.active;
                    this.butn( (exists.active ? "iconPaus" : "iconPlay") );

                    return exists[ (exists.active ? "play" : "pause") ]();
                };


                this.butn( "iconBusy" );


                Client.import( memory.preset[memory.chosen] ).then(( object )=>
                {
                    object.listen
                    ({
                        play ()
                        {
                            Viewer.action.butn( "iconPaus" );
                        },


                        pause ()
                        {
                            Viewer.action.butn( "iconPlay" );
                        },


                        canplaythrough ()
                        {
                            this.play();
                            this.active = true;
                        }
                    });


                    Select( "#offscreen" ).append( object.aspect({id:"activeAudio"}) );
                });
            },


            tube ()
            {
                window.open( "https://youtube.com/@CharlSteynberg" );
            },


            call ()
            {
                window.open( "https://wa.me/27645588365" );
            },


            link ()
            {
                window.open( "https://www.linkedin.com/company/xacra" );
            },


            repo ()
            {
                window.open( "https://github.com/xacra" );
            },


            conf ()
            {
                Viewer.canvas.halted = !Viewer.canvas.halted;
                Viewer.canvas.hud.toggle();

                let halted = Viewer.canvas.halted;
                let action = (halted ? "enclan" : "declan");

                document.body.parentNode[ action ]( "flowHide" );
                Select( "#overlay" )[ action ]( "secluded" );
                Screen.canvas.styled( {cursor:(halted ? "grab" : "default")} );
            },
        }
    });
// ============================================================================================================================






// action :: aspect : info
// ----------------------------------------------------------------------------------------------------------------------------
    Viewer.listen
    ({
        loaded ( iframe )
        {
            let limits = { min:100.0, max:1000.0 };
            let number = 0,  values,  direct="-",  factor=0.999,  zoomed;


            Client.import( "./assets/banner.svg" ).then(( banner )=>
            {
                Select( "#browse" ).append( banner.aspect({class:"banner cenmid"}) );


                ("Play Tube Call Link Repo Conf").split(" ").map(( naming )=>
                {
                    if ( naming !== "Play" )
                    {
                        Select( `#butn${naming}` ).styled({opacity:0.5})
                        Select( `#icon${naming}` ).styled( {opacity:1} );
                    };


                    Select( `#butn${naming}` )
                    .listen
                    ({
                        mouseover ()
                        {
                            let hitbox = this;
                            let button = ( (hitbox.id === "butnPlay") ? Viewer.action.butn() : hitbox );

                            hitbox.styled( {cursor:"pointer"} );
                            button.styled( {opacity:1} );
                        },


                        click ()
                        {
                            dump( "action: " + (this.id).slice(4).toLowerCase() );
                            Viewer.action[ (this.id).slice(4).toLowerCase() ]();
                        },


                        mouseout ()
                        {
                            let hitbox = this;
                            let button = ( (hitbox.id === "butnPlay") ? Viewer.action.butn() : hitbox );

                            hitbox.styled( {cursor:"default"} );
                            button.styled( {opacity:0.5} );
                        },
                    });
                });
            });




            Device.listen
            ({
                keydown ( signal )
                {
                    if ( signal.key !== "Escape" )
                    { return }; // toggle key

                    Viewer.action.conf();
                },


                mousemove ( signal )
                {
                    // dump(signal);
                }
            });



            Viewer.canvas.config(`X +0.10681649\nY +0.6373687581\nZ +100`);


            Method.awaits(100, ()=>
            {
                if ( Viewer.canvas.halted )
                { return };


                values = Viewer.canvas.config();
                zoomed = ( values.Z * factor );


                if ( (zoomed > limits.min) && (zoomed < limits.max) )
                {
                    values.Z = zoomed;
                    this.canvas.config( values );
                    return;
                };


                if ( direct === "-" )
                {
                    direct = "+";
                    factor = 1.001;
                }
                else
                {
                    direct = "-";
                    factor = 0.999;
                };
            });

        }
    })
// ============================================================================================================================






// action :: aspect : info
// ----------------------------------------------------------------------------------------------------------------------------
    Global.listen
    ({
        loadedScript ()
        {
            Select( "#mandel" ).listen
            ({
                load ()
                {
                    if ( !this.canvas )
                    { return this.canvas = this.contentDocument.canvas };


                    Viewer.extend( {canvas:this.canvas} );
                    Viewer.signal( "loaded", this );
                }
            })
            .aspect
            ({
                src:"assets/mandel.htm"
            })
        }
    });
// ============================================================================================================================
